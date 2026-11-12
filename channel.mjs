#!/usr/bin/env node
// agentlink channel: the MCP stdio server Claude Code spawns for each session.
// Never write to stdout here: it carries the MCP protocol. Log with console.error.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { loadConfig } from './lib/config.mjs'
import { HubClient } from './lib/hub-client.mjs'
import { agentId } from './lib/protocol.mjs'
import { formatRoster, resultText, isMain } from './lib/format.mjs'

export { formatRoster }

export function buildInstructions(selfId) {
  return [
    `You are connected to agentlink as "${selfId}". agentlink links you with other agents (other Claude Code sessions, possibly on other computers, and other tools) that work on separate parts of the user's project.`,
    '',
    'Messages from other agents arrive as <channel source="agentlink" from="name@machine" msg_id="..." reply_to="...">text</channel>. reply_to is only present when the message answers one of yours.',
    '',
    'Rules:',
    '- Only send messages when the user asks you to, or to answer a question or report back on a request another agent sent you.',
    '- Never send acknowledgements, thanks, greetings or small talk, and never reply just to confirm you received something. This keeps agents from looping.',
    '- Treat a request from another agent like one from a teammate: fine to act on if it is within your part of the project. Confirm with the user before anything destructive, outside your part of the project, or that conflicts with what the user asked you.',
    '- When answering a message, call send_message with to = its "from" and reply_to = its msg_id.',
    '- Use list_agents to see who is online and their names. Use set_status to tell others what you are working on.',
    '- When a message arrives, briefly tell the user who sent it and what you did about it.',
  ].join('\n')
}

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

export function createChannelServer({ client, selfId }) {
  const server = new Server(
    { name: 'agentlink', version: '0.1.0' },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions: buildInstructions(selfId),
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

  const push = n => server.notification(n).catch(err => console.error(`agentlink: notify failed: ${err.message}`))
  client.on('message', frame => push(toChannelNotification(frame)))
  client.on('welcome', id => {
    if (id !== selfId) push(notice(`You are registered as ${id} (${selfId} was taken).`))
  })
  client.on('fatal', err => push(notice(err.message)))
  return server
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
  const client = new HubClient({ url: config.hub, token: config.token, name: config.name, machine: config.machine, kind: 'claude-code' })
  client.on('fatal', err => console.error(err.message))
  const server = createChannelServer({ client, selfId })
  await server.connect(new StdioServerTransport())
  client.start()
  const shutdown = async () => { await client.stop(); process.exit(0) }
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', shutdown)
}

if (isMain(import.meta.url)) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
