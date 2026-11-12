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
