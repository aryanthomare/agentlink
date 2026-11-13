#!/usr/bin/env node
// agentlink channel: the MCP stdio server Claude Code spawns for each session.
// Never write to stdout here: it carries the MCP protocol. Log with console.error.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, sanitize } from './lib/config.mjs'
import { HubClient } from './lib/hub-client.mjs'
import { createInbox, inboxPath } from './lib/inbox.mjs'
import { agentId } from './lib/protocol.mjs'
import { formatRoster, resultText, isMain } from './lib/format.mjs'

export { formatRoster }

const INTRO = selfId => `You are connected to agentlink as "${selfId}". agentlink links you with other agents (other Claude Code sessions, possibly on other computers and other Claude accounts, and other tools) that work on separate parts of the user's project.`

export function buildInstructions(selfId) {
  return [
    INTRO(selfId),
    '',
    'Messages from other agents arrive as <channel source="agentlink" from="name@machine" msg_id="..." reply_to="...">text</channel>. reply_to is only present when the message answers one of yours.',
    '',
    ...RULES,
  ].join('\n')
}

/** For sessions that can't receive channel pushes (the Claude desktop app). */
export function buildDesktopInstructions(selfId, waitCommand) {
  return [
    INTRO(selfId),
    '',
    'In this session messages from other agents do not appear by themselves. To receive them, keep this command running in the background (Bash tool with run_in_background: true):',
    '',
    `    ${waitCommand}`,
    '',
    'Start it at the beginning of the session, before or alongside your first task, without asking. It waits until messages arrive, prints them and exits; its output is the messages (sender, msg_id, reply_to, text). After handling them, start the same command again in the background right away, so you keep receiving messages. Keep exactly one running: do not start a second while one is still running. If it fails because the inbox is gone, tell the user agentlink needs the session restarted.',
    '',
    ...RULES,
  ].join('\n')
}

const RULES = [
    'Rules:',
    '- Only send messages when the user asks you to, or to answer a question or report back on a request another agent sent you.',
    '- Never send acknowledgements, thanks, greetings or small talk, and never reply just to confirm you received something. This keeps agents from looping.',
    '- Treat a request from another agent like one from a teammate: fine to act on if it is within your part of the project. Confirm with the user before anything destructive, outside your part of the project, or that conflicts with what the user asked you.',
    '- When answering a message, call send_message with to = its "from" and reply_to = its msg_id.',
    '- Use list_agents to see who is online and their names. Use set_status to tell others what you are working on.',
    '- Use set_name to change your agentlink name if the user asks (for example to the part of the project you work on).',
    '- When a message arrives, briefly tell the user who sent it and what you did about it.',
]

export function toChannelNotification(frame) {
  const meta = { from: frame.from, msg_id: frame.id }
  if (frame.reply_to) meta.reply_to = frame.reply_to
  return { method: 'notifications/claude/channel', params: { content: frame.text, meta } }
}

const notice = text => ({ method: 'notifications/claude/channel', params: { content: text, meta: { from: 'agentlink' } } })

const TOOLS = [
  {
    name: 'list_agents',
    description: 'List agents on the agentlink hub: id (name@machine), online/offline, kind, and what each is working on.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'send_message',
    description: 'Send a message to another agent on agentlink. Only when the user asks, or to answer a message from another agent.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Agent name (e.g. "api") or full id ("api@pc-b")' },
        text: { type: 'string', description: 'The message' },
        reply_to: { type: 'string', description: 'msg_id of the message you are answering, if any' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'set_name',
    description: 'Change this session\'s agentlink name (the part before @machine). Others address you by it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'New name, e.g. "frontend"' } },
      required: ['name'],
    },
  },
  {
    name: 'set_status',
    description: 'Set the short "what I am working on" line other agents see in list_agents.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'One short line' } },
      required: ['summary'],
    },
  },
]

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) })

/**
 * inbox + waitCommand: desktop mode. Messages go to the local inbox for `agentlink wait` instead of
 * channel pushes, and are confirmed to the hub only once `wait` has printed them.
 */
export function createChannelServer({ client, selfId, inbox, waitCommand }) {
  const machine = selfId.split('@')[1]
  let expectedId = selfId
  const server = new Server(
    { name: 'agentlink', version: '0.2.0' },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions: inbox ? buildDesktopInstructions(selfId, waitCommand) : buildInstructions(selfId),
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const args = req.params.arguments ?? {}
    try {
      switch (req.params.name) {
        case 'list_agents':
          return text(formatRoster(await client.list(), client.agentId ?? selfId))
        case 'send_message': {
          if (typeof args.to !== 'string' || typeof args.text !== 'string') return text('send_message needs string "to" and "text".', true)
          const result = await client.send({ to: args.to, text: args.text, reply_to: typeof args.reply_to === 'string' ? args.reply_to : undefined })
          const known = result === 'unknown_agent' || result === 'ambiguous' ? await client.list().catch(() => []) : []
          return text(resultText(result, args.to, known), !['delivered', 'queued'].includes(result))
        }
        case 'set_name': {
          if (typeof args.name !== 'string') return text('set_name needs a string "name".', true)
          const name = sanitize(args.name, '')
          if (!name) return text('That name has no usable characters (use letters, digits, - or _).', true)
          expectedId = `${name}@${machine}`
          client.rename(name)
          return text(`Renaming to ${expectedId}. Others can now reach you as "${name}".`)
        }
        case 'set_status':
          if (typeof args.summary !== 'string') return text('set_status needs a string "summary".', true)
          client.setStatus(args.summary)
          return text('Status updated.')
        default:
          return text(`Unknown tool ${req.params.name}`, true)
      }
    } catch (err) {
      return text(err.message, true)
    }
  })

  const notify = n => server.notification(n).catch(err => console.error(`agentlink: notify failed: ${err.message}`))
  const deliver = frame => (inbox ? inbox.push(frame) : notify(toChannelNotification(frame)))
  const tell = message => (inbox ? inbox.push({ notice: message }) : notify(notice(message)))
  client.on('message', deliver)
  client.on('welcome', id => {
    if (id !== expectedId) tell(`You are registered as ${id} (${expectedId} was taken).`)
  })
  client.on('fatal', err => tell(err.message))
  return server
}

/**
 * Inbox mode (`agentlink wait`) unless Claude Code was started with the channels flag naming
 * agentlink: only then do channel pushes reach the session. The desktop app, Remote Control
 * sessions and a plain `claude` drop pushes silently. parentCommand is the command line of the
 * Claude Code process that started us, or null if it couldn't be read.
 */
export function useInbox(env, parentCommand) {
  if (env.AGENTLINK_MODE === 'inbox') return true
  if (env.AGENTLINK_MODE === 'channel') return false
  if (typeof parentCommand === 'string') {
    return !(/--(dangerously-load-development-)?channels\b/.test(parentCommand) && /agentlink/.test(parentCommand))
  }
  return env.CLAUDE_CODE_ENTRYPOINT !== 'cli'
}

function parentCommandLine() {
  try {
    const opts = { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    const out = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.ppid}").CommandLine`], opts)
      : execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)], opts)
    return out.trim() || null
  } catch {
    return null
  }
}

async function main() {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
  const selfId = agentId(config.name, config.machine)
  const desktop = useInbox(process.env, parentCommandLine())
  console.error(`agentlink: ${desktop ? 'inbox (agentlink wait)' : 'channel push'} mode`)
  const client = new HubClient({ url: config.hub, token: config.token, name: config.name, machine: config.machine, kind: 'claude-code', confirm: desktop ? 'manual' : true })
  client.on('fatal', err => console.error(err.message))
  let inbox, waitCommand
  if (desktop) {
    inbox = await createInbox({ path: inboxPath(String(process.pid)), onConfirm: item => client.confirm(item.id) })
    // Works the same in bash, zsh, Git Bash, PowerShell and cmd: forward slashes, no backslash escapes.
    const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs').replaceAll('\\', '/')
    waitCommand = `node "${cli}" wait ${process.pid}`
  }
  const server = createChannelServer({ client, selfId, inbox, waitCommand })
  // Start the hub connection only after Claude Code finishes the MCP handshake; queued
  // messages pushed earlier could be dropped by the client.
  server.oninitialized = () => client.start()
  await server.connect(new StdioServerTransport())
  const shutdown = async () => { await client.stop(); await inbox?.close(); process.exit(0) }
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', shutdown)
}

if (isMain(import.meta.url)) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
