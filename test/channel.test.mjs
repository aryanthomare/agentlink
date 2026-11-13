import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { toChannelNotification, buildInstructions, formatRoster, useInbox } from '../channel.mjs'
import { createHub } from '../hub.mjs'
import { HubClient } from '../lib/hub-client.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('notification shape', () => {
  const frame = { type: 'message', id: 'm1', from: 'api@b', to: 'x@a', text: 'hi', sent_at: '2026-11-12T00:00:00Z' }
  assert.deepEqual(toChannelNotification(frame), {
    method: 'notifications/claude/channel',
    params: { content: 'hi', meta: { from: 'api@b', msg_id: 'm1' } },
  })
  const withReply = toChannelNotification({ ...frame, reply_to: 'm0' })
  assert.equal(withReply.params.meta.reply_to, 'm0')
  for (const key of Object.keys(withReply.params.meta)) assert.match(key, /^[A-Za-z0-9_]+$/)
})

test('instructions carry the rules', () => {
  const text = buildInstructions('web@mac')
  assert.ok(text.includes('web@mac'))
  assert.ok(text.includes('reply_to'))
  assert.ok(text.includes('list_agents'))
  assert.match(text, /never send acknowledg/i)
  assert.match(text, /confirm with the user/i)
})

test('pushes only when Claude Code was started with the agentlink channel flag', () => {
  const flagged = 'claude --dangerously-load-development-channels server:agentlink'
  assert.equal(useInbox({ CLAUDE_CODE_ENTRYPOINT: 'cli' }, flagged), false)
  assert.equal(useInbox({ CLAUDE_CODE_ENTRYPOINT: 'cli' }, 'claude --channels plugin:agentlink@mine'), false)
  assert.equal(useInbox({ CLAUDE_CODE_ENTRYPOINT: 'cli' }, 'claude'), true, 'terminal without the flag')
  assert.equal(useInbox({ CLAUDE_CODE_ENTRYPOINT: 'cli' }, 'claude --dangerously-load-development-channels server:other'), true)
  assert.equal(useInbox({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, '/x/claude --print --sdk-url https://a/b'), true, 'remote control')
  assert.equal(useInbox({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, '/x/claude'), true, 'desktop app')
  // parent command unknown (e.g. lookup failed): fall back to the entrypoint
  assert.equal(useInbox({ CLAUDE_CODE_ENTRYPOINT: 'cli' }, null), false)
  assert.equal(useInbox({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, null), true)
  // explicit override wins
  assert.equal(useInbox({ AGENTLINK_MODE: 'channel', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, 'claude'), false)
  assert.equal(useInbox({ AGENTLINK_MODE: 'inbox' }, flagged), true)
})

test('roster formatting', () => {
  const agents = [
    { id: 'api@b', name: 'api', kind: 'claude-code', summary: 'auth', online: false, since: '' },
    { id: 'web@a', name: 'web', kind: 'claude-code', summary: '', online: true, since: '' },
  ]
  const out = formatRoster(agents, 'web@a')
  assert.match(out, /web@a \(you\)/)
  assert.match(out, /api@b\s+offline\s+claude-code\s+auth/)
  assert.equal(formatRoster([], 'web@a'), 'No agents connected.')
})

test('end-to-end over stdio', async t => {
  const hub = await createHub({ token: 'tok', port: 0 })
  const peer = new HubClient({ url: `ws://127.0.0.1:${hub.port}`, token: 'tok', name: 'api', machine: 'test', kind: 'test', minBackoffMs: 50 })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'channel.mjs')],
    env: {
      PATH: process.env.PATH,
      HOME: mkdtempSync(join(tmpdir(), 'agentlink-home-')),
      AGENTLINK_TOKEN: 'tok',
      AGENTLINK_HUB: `ws://127.0.0.1:${hub.port}`,
      AGENTLINK_NAME: 'web',
      AGENTLINK_HOST: 'mac',
      AGENTLINK_MODE: 'channel',
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'test', version: '0.0.0' })
  const notes = []
  let notify
  client.fallbackNotificationHandler = async n => {
    notes.push(n)
    notify?.()
  }
  t.after(async () => {
    await client.close()
    await peer.stop()
    await hub.close()
  })

  await client.connect(transport)
  assert.deepEqual(client.getServerCapabilities().experimental?.['claude/channel'], {})
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(x => x.name).sort(), ['list_agents', 'send_message', 'set_name', 'set_status'])

  const welcomed = once(peer, 'welcome')
  peer.start()
  await welcomed
  // wait until the channel's own hub connection is up
  for (let i = 0; i < 50 && !(await peer.list()).some(a => a.id === 'web@mac' && a.online); i++) {
    await new Promise(r => setTimeout(r, 50))
  }

  const arrived = new Promise(r => { notify = r })
  assert.equal(await peer.send({ to: 'web', text: 'ping' }), 'delivered')
  await arrived
  const note = notes.find(n => n.method === 'notifications/claude/channel')
  assert.equal(note.params.content, 'ping')
  assert.equal(note.params.meta.from, 'api@test')

  const reply = once(peer, 'message')
  const res = await client.callTool({ name: 'send_message', arguments: { to: 'api', text: 'pong' } })
  assert.equal(res.content[0].text, 'Delivered to api.')
  const [msg] = await reply
  assert.equal(msg.text, 'pong')
})

test('does not push messages before Claude Code initializes, and keeps them queued', async t => {
  const { spawn } = await import('node:child_process')
  const hub = await createHub({ token: 'tok', port: 0 })
  const url = `ws://127.0.0.1:${hub.port}`
  t.after(() => hub.close())
  // register web@mac once so the hub knows it, then go offline
  const web = new HubClient({ url, token: 'tok', name: 'web', machine: 'mac', kind: 'test' })
  const w = once(web, 'welcome'); web.start(); await w; await web.stop()
  const peer = new HubClient({ url, token: 'tok', name: 'api', machine: 'test', kind: 'test' })
  const p = once(peer, 'welcome'); peer.start(); await p
  t.after(() => peer.stop())
  assert.equal(await peer.send({ to: 'web', text: 'early' }), 'queued')

  const env = { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), 'al-')), AGENTLINK_TOKEN: 'tok', AGENTLINK_HUB: url, AGENTLINK_NAME: 'web', AGENTLINK_HOST: 'mac', AGENTLINK_MODE: 'channel' }
  const child = spawn(process.execPath, [join(ROOT, 'channel.mjs')], { env, stdio: ['pipe', 'pipe', 'ignore'] })
  let stdout = ''
  child.stdout.on('data', d => { stdout += d })
  await new Promise(r => setTimeout(r, 1500))
  child.kill()
  await once(child, 'exit')
  assert.equal(stdout, '', 'channel wrote to stdout before initialize')

  // the message must still be waiting for a properly initialized session
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'channel.mjs')], env, stderr: 'pipe' })
  const client = new Client({ name: 'test', version: '0.0.0' })
  const arrived = new Promise(resolve => {
    client.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') resolve(n) }
  })
  t.after(() => client.close())
  await client.connect(transport)
  assert.equal((await arrived).params.content, 'early')
})

// --- desktop (inbox) mode -------------------------------------------------------------
const { execFile } = await import('node:child_process')
const runWait = (id, home) => new Promise(resolve => {
  execFile(process.execPath, [join(ROOT, 'cli.mjs'), 'wait', id], { timeout: 10000, env: { PATH: process.env.PATH, HOME: home } }, (err, stdout, stderr) =>
    resolve({ code: err ? err.code ?? 'killed' : 0, stdout, stderr }))
})

async function desktopChannel(t, url, home) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'channel.mjs')],
    env: { PATH: process.env.PATH, HOME: home, AGENTLINK_TOKEN: 'tok', AGENTLINK_HUB: url, AGENTLINK_NAME: 'web', AGENTLINK_HOST: 'mac', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'test', version: '0.0.0' })
  const notes = []
  client.fallbackNotificationHandler = async n => { notes.push(n) }
  await client.connect(transport)
  const instructions = client.getInstructions()
  // shell-neutral: forward slashes, no backslashes, inbox given by number
  const id = /wait (\d+)\s*$/m.exec(instructions)?.[1]
  return { client, notes, instructions, id, home, close: () => client.close() }
}

async function onlineAs(peer, id) {
  for (let i = 0; i < 100; i++) {
    if ((await peer.list()).some(a => a.id === id && a.online)) return
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`${id} never came online`)
}

test('desktop mode: messages arrive through agentlink wait, not channel pushes', async t => {
  const hub = await createHub({ token: 'tok', port: 0 })
  const url = `ws://127.0.0.1:${hub.port}`
  const peer = new HubClient({ url, token: 'tok', name: 'api', machine: 'test', kind: 'test' })
  const p = once(peer, 'welcome'); peer.start(); await p
  const home = mkdtempSync(join(tmpdir(), 'al-'))
  let ch = await desktopChannel(t, url, home)
  t.after(async () => { await ch.close(); await peer.stop(); await hub.close() })

  assert.ok(ch.id, `no wait command in instructions:\n${ch.instructions}`)
  assert.doesNotMatch(/^ {4}node .*$/m.exec(ch.instructions)[0], /\\/)
  assert.match(ch.instructions, /run_in_background/)
  assert.match(ch.instructions, /never send acknowledg/i)
  await onlineAs(peer, 'web@mac')

  assert.equal(await peer.send({ to: 'web', text: 'ping\nsecond line' }), 'delivered')
  const out = await runWait(ch.id, ch.home)
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, /from api@test/)
  assert.match(out.stdout, /ping\nsecond line/)
  assert.match(out.stdout, /msg_id/)
  assert.match(out.stdout, /again/)
  assert.equal(ch.notes.filter(n => n.method === 'notifications/claude/channel').length, 0)

  // confirmed: a restarted session does not get it again
  await ch.close()
  ch = await desktopChannel(t, url, home)
  await onlineAs(peer, 'web@mac')
  await peer.send({ to: 'web', text: 'two' })
  const again = await runWait(ch.id, ch.home)
  assert.doesNotMatch(again.stdout, /ping/)
  assert.match(again.stdout, /two/)
})

test('desktop mode: messages nobody waited for survive a session restart', async t => {
  const hub = await createHub({ token: 'tok', port: 0 })
  const url = `ws://127.0.0.1:${hub.port}`
  const peer = new HubClient({ url, token: 'tok', name: 'api', machine: 'test', kind: 'test' })
  const p = once(peer, 'welcome'); peer.start(); await p
  const home = mkdtempSync(join(tmpdir(), 'al-'))
  let ch = await desktopChannel(t, url, home)
  t.after(async () => { await ch.close(); await peer.stop(); await hub.close() })
  await onlineAs(peer, 'web@mac')
  assert.equal(await peer.send({ to: 'web', text: 'unseen' }), 'delivered')
  await new Promise(r => setTimeout(r, 200))
  await ch.close()
  ch = await desktopChannel(t, url, home)
  const out = await runWait(ch.id, ch.home)
  assert.match(out.stdout, /unseen/)
})

test('set_name renames the session on the hub', async t => {
  const hub = await createHub({ token: 'tok', port: 0 })
  const url = `ws://127.0.0.1:${hub.port}`
  const peer = new HubClient({ url, token: 'tok', name: 'api', machine: 'test', kind: 'test' })
  const p = once(peer, 'welcome'); peer.start(); await p
  const ch = await desktopChannel(t, url, mkdtempSync(join(tmpdir(), 'al-')))
  t.after(async () => { await ch.close(); await peer.stop(); await hub.close() })
  await onlineAs(peer, 'web@mac')
  const res = await ch.client.callTool({ name: 'set_name', arguments: { name: 'UI Team' } })
  assert.match(res.content[0].text, /ui-team@mac/)
  await onlineAs(peer, 'ui-team@mac')
})

test('wait without an inbox path prints usage', async () => {
  const out = await new Promise(resolve => execFile(process.execPath, [join(ROOT, 'cli.mjs'), 'wait'], (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stderr })))
  assert.equal(out.code, 1)
  assert.match(out.stderr, /usage: agentlink wait/)
})

test('a replaced wait says not to restart it', async t => {
  const hub = await createHub({ token: 'tok', port: 0 })
  const url = `ws://127.0.0.1:${hub.port}`
  const ch = await desktopChannel(t, url, mkdtempSync(join(tmpdir(), 'al-')))
  t.after(async () => { await ch.close(); await hub.close() })
  const older = runWait(ch.id, ch.home)
  await new Promise(r => setTimeout(r, 300))
  const newer = runWait(ch.id, ch.home)
  const out = await older
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, /took over.*do not start another/)
  await ch.close()
  assert.match((await newer).stderr, /inbox closed/)
})
