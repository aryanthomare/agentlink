import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { toChannelNotification, buildInstructions, formatRoster } from '../channel.mjs'
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
  assert.deepEqual(tools.map(x => x.name).sort(), ['list_agents', 'send_message', 'set_status'])

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

  const env = { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), 'al-')), AGENTLINK_TOKEN: 'tok', AGENTLINK_HUB: url, AGENTLINK_NAME: 'web', AGENTLINK_HOST: 'mac' }
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
