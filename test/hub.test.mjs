import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHub } from '../hub.mjs'
import { open, connect, sleep } from './helpers.mjs'

const TOKEN = 'secret'
let hub
const conns = []
const join = async opts => {
  const c = await connect(hub.port, { token: TOKEN, ...opts })
  conns.push(c)
  return c
}
const raw = async () => {
  const c = open(hub.port)
  await c.opened
  conns.push(c)
  return c
}

beforeEach(async () => {
  hub = await createHub({ token: TOKEN, port: 0, pingMs: 200, helloMs: 200 })
})
afterEach(async () => {
  for (const c of conns.splice(0)) c.ws.terminate()
  await hub.close()
})

test('rejects bad token', async () => {
  const c = await raw()
  c.sendFrame({ type: 'hello', v: 1, token: 'nope', name: 'a', machine: 'm', kind: 'test' })
  const err = await c.next('error')
  assert.equal(err.code, 'bad_token')
  assert.equal((await c.closed).code, 4001)
})

test('rejects frames before hello', async () => {
  const c = await raw()
  c.sendFrame({ type: 'list' })
  assert.equal((await c.next('error')).code, 'hello_required')
  assert.equal((await c.closed).code, 4004)

  const silent = await raw()
  assert.equal((await silent.closed).code, 4004)
})

test('welcome gives agent id', async () => {
  const b = await join({ name: 'api', machine: 'pc-b' })
  assert.equal(b.welcome.agent_id, 'api@pc-b')
})

test('rejects duplicate online id', async () => {
  const first = await join({ name: 'api', machine: 'pc-b' })
  const dup = await raw()
  dup.sendFrame({ type: 'hello', v: 1, token: TOKEN, name: 'api', machine: 'pc-b', kind: 'test' })
  assert.equal((await dup.next('error')).code, 'name_taken')
  assert.equal((await dup.closed).code, 4002)
  assert.equal(first.ws.readyState, first.ws.OPEN)
})

test('same session takes over a stale connection', async () => {
  const hello = { type: 'hello', v: 1, token: TOKEN, name: 'api', machine: 'pc-b', kind: 'test', session: 's1' }
  const stale = await raw()
  stale.sendFrame(hello)
  await stale.next('welcome')
  const fresh = await raw()
  fresh.sendFrame(hello)
  assert.equal((await fresh.next('welcome')).agent_id, 'api@pc-b')
  await stale.closed

  const a = await join({ name: 'front' })
  a.sendFrame({ type: 'send', id: 's', to: 'api', text: 'x' })
  assert.equal((await a.next('ack')).result, 'delivered')
  assert.equal((await fresh.next('message')).id, 's')
})

test('delivers by bare name and acks', async () => {
  const a = await join({ name: 'front' })
  const b = await join({ name: 'api', machine: 'pc-b' })
  a.sendFrame({ type: 'send', id: 'm1', to: 'api', text: 'hi', reply_to: 'm0' })
  assert.deepEqual(await a.next('ack'), { type: 'ack', id: 'm1', result: 'delivered' })
  const msg = await b.next('message')
  assert.equal(msg.id, 'm1')
  assert.equal(msg.from, 'front@test')
  assert.equal(msg.to, 'api@pc-b')
  assert.equal(msg.text, 'hi')
  assert.equal(msg.reply_to, 'm0')
  assert.ok(!Number.isNaN(Date.parse(msg.sent_at)))
})

test('unknown and ambiguous', async () => {
  const a = await join({ name: 'front' })
  await join({ name: 'api', machine: 'pc-a' })
  await join({ name: 'api', machine: 'pc-b' })
  a.sendFrame({ type: 'send', id: 'u', to: 'ghost', text: 'x' })
  assert.equal((await a.next('ack')).result, 'unknown_agent')
  a.sendFrame({ type: 'send', id: 'v', to: 'api', text: 'x' })
  assert.equal((await a.next('ack')).result, 'ambiguous')
  a.sendFrame({ type: 'send', id: 'w', to: 'api@pc-a', text: 'x' })
  assert.equal((await a.next('ack')).result, 'delivered')
})

test('queues for offline agent and flushes in order', async () => {
  const a = await join({ name: 'front' })
  const b = await join({ name: 'api' })
  await b.close()
  a.sendFrame({ type: 'send', id: 'q1', to: 'api', text: 'one' })
  assert.equal((await a.next('ack')).result, 'queued')
  a.sendFrame({ type: 'send', id: 'q2', to: 'api', text: 'two' })
  assert.equal((await a.next('ack')).result, 'queued')

  const b2 = await join({ name: 'api' })
  assert.equal((await b2.next('message')).id, 'q1')
  assert.equal((await b2.next('message')).id, 'q2')
})

test('queue drops oldest past 100', async () => {
  const a = await join({ name: 'front' })
  const b = await join({ name: 'api' })
  await b.close()
  for (let i = 0; i < 101; i++) a.sendFrame({ type: 'send', id: `q${i}`, to: 'api', text: String(i) })
  for (let i = 0; i < 101; i++) await a.next('ack')

  const b2 = await join({ name: 'api' })
  const got = []
  for (let i = 0; i < 100; i++) got.push((await b2.next('message')).id)
  assert.equal(got[0], 'q1')
  assert.equal(got[99], 'q100')
  await sleep(50)
  assert.equal(b2.buffer.filter(f => f.type === 'message').length, 0)
})

test('roster shows online state and summary', async () => {
  const a = await join({ name: 'front' })
  const b = await join({ name: 'api', machine: 'pc-b', summary: 'auth work' })
  b.sendFrame({ type: 'status', summary: 'tests' })
  await sleep(20)
  a.sendFrame({ type: 'list' })
  const { agents } = await a.next('roster')
  assert.deepEqual(agents.map(x => x.id), ['api@pc-b', 'front@test'])
  const api = agents[0]
  assert.equal(api.kind, 'test')
  assert.equal(api.summary, 'tests')
  assert.equal(api.online, true)
  assert.equal(api.name, 'api')

  await b.close()
  a.sendFrame({ type: 'list' })
  const after = await a.next('roster')
  assert.equal(after.agents.find(x => x.id === 'api@pc-b').online, false)
})

test('text round-trips and cap counts bytes', async () => {
  const a = await join({ name: 'front' })
  const b = await join({ name: 'api' })
  const fancy = 'line1\nline2 🚀 ünïcode'
  a.sendFrame({ type: 'send', id: 't1', to: 'api', text: fancy })
  await a.next('ack')
  assert.equal((await b.next('message')).text, fancy)

  a.sendFrame({ type: 'send', id: 't2', to: 'api', text: 'é'.repeat(16400) })
  assert.equal((await a.next('ack')).result, 'too_large')

  a.sendFrame({ type: 'send', id: 't3', to: 'api', text: 'a'.repeat(32768) })
  assert.equal((await a.next('ack')).result, 'delivered')
  assert.equal((await b.next('message')).id, 't3')
})

test('malformed frame closes', async () => {
  const a = await join({ name: 'front' })
  a.sendFrame('not json')
  assert.equal((await a.next('error')).code, 'bad_frame')
  assert.equal((await a.closed).code, 4003)
})

test('dead peer marked offline', async () => {
  const a = await join({ name: 'front' })
  const b = await join({ name: 'api' })
  b.ws._socket.pause()
  await sleep(600)
  a.sendFrame({ type: 'list' })
  const { agents } = await a.next('roster')
  assert.equal(agents.find(x => x.id === 'api@test').online, false)
})
