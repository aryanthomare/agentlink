import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createHub } from '../hub.mjs'
import { HubClient } from '../lib/hub-client.mjs'
import { sleep } from './helpers.mjs'

const TOKEN = 'secret'
const hubs = []
const clients = []

const startHub = async (port = 0) => {
  const h = await createHub({ token: TOKEN, port, pingMs: 200 })
  hubs.push(h)
  return h
}
const client = (port, opts = {}) => {
  const c = new HubClient({
    url: `ws://127.0.0.1:${port}`,
    token: TOKEN,
    machine: 'm',
    kind: 'test',
    minBackoffMs: 50,
    maxBackoffMs: 200,
    timeoutMs: 300,
    ...opts,
  })
  clients.push(c)
  return c
}
const started = async c => {
  const welcomed = once(c, 'welcome')
  c.start()
  await welcomed
  return c
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop()
  for (const h of hubs.splice(0)) await h.close()
})

test('connects, sends and receives', async () => {
  const hub = await startHub()
  const a = await started(client(hub.port, { name: 'a' }))
  const b = await started(client(hub.port, { name: 'b' }))
  const got = once(b, 'message')
  assert.equal(await a.send({ to: 'b', text: 'x' }), 'delivered')
  const [msg] = await got
  assert.equal(msg.text, 'x')
  assert.equal(msg.from, a.agentId)
})

test('list returns roster', async () => {
  const hub = await startHub()
  const a = await started(client(hub.port, { name: 'a' }))
  const b = await started(client(hub.port, { name: 'b' }))
  const ids = (await a.list()).map(r => r.id)
  assert.ok(ids.includes(a.agentId) && ids.includes(b.agentId))
})

test('unreachable hub fails fast with url', async () => {
  const dead = await startHub()
  const port = dead.port
  await hubs.pop().close()
  const c = client(port, { name: 'c' })
  c.start()
  const t0 = Date.now()
  await assert.rejects(c.send({ to: 'b', text: 'x' }), /hub unreachable at ws:\/\/127\.0\.0\.1:\d+/)
  await assert.rejects(c.list(), /hub unreachable/)
  assert.ok(Date.now() - t0 < 100)
})

test('reconnects after hub restart keeping id and status', async () => {
  const hub = await startHub()
  const port = hub.port
  const a = await started(client(port, { name: 'a' }))
  const b = await started(client(port, { name: 'b' }))
  const idBefore = a.agentId
  a.setStatus('docs')

  await hubs.pop().close()
  const backA = once(a, 'welcome')
  const backB = once(b, 'welcome')
  await startHub(port)
  await Promise.all([backA, backB])

  assert.equal(a.agentId, idBefore)
  const entry = (await b.list()).find(r => r.id === idBefore)
  assert.equal(entry.summary, 'docs')
  assert.equal(await a.send({ to: 'b', text: 'again' }), 'delivered')
})

test('takes name-2 when name is taken', async () => {
  const hub = await startHub()
  const first = await started(client(hub.port, { name: 'web' }))
  const second = await started(client(hub.port, { name: 'web' }))
  assert.equal(first.agentId, 'web@m')
  assert.equal(second.agentId, 'web-2@m')
})

test('bad token is fatal', async () => {
  const hub = await startHub()
  const c = client(hub.port, { name: 'c', token: 'wrong' })
  let fatals = 0
  c.on('fatal', () => fatals++)
  c.start()
  await sleep(300)
  assert.equal(fatals, 1)
  assert.equal(c.connected, false)
})
