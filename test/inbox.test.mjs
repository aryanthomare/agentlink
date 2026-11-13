import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInbox, waitInbox, inboxPath } from '../lib/inbox.mjs'
import { sleep } from './helpers.mjs'

const tmpPath = () => join(mkdtempSync(join(tmpdir(), 'al-inbox-')), 'x.sock')
const msg = (id, text = id) => ({ type: 'message', id, from: 'api@b', to: 'web@a', text, sent_at: '' })

test('inboxPath per platform', () => {
  assert.equal(inboxPath('123', { home: '/h', platform: 'darwin' }), join('/h', '.agentlink', 'run', '123.sock'))
  assert.equal(inboxPath('123', { home: 'C:\\h', platform: 'win32' }), '\\\\.\\pipe\\agentlink-123')
})

test('wait blocks until a push, gets pending in order, confirms after ack', async t => {
  const confirmed = []
  const inbox = await createInbox({ path: tmpPath(), onConfirm: item => confirmed.push(item.id) })
  t.after(() => inbox.close())
  let done = false
  const waiting = waitInbox(inbox.path).then(items => { done = true; return items })
  await sleep(100)
  assert.equal(done, false, 'wait returned with nothing pending')
  inbox.push(msg('m1'))
  inbox.push(msg('m2'))
  const items = await waiting
  assert.deepEqual(items.map(i => i.id).slice(0, 1), ['m1'])
  await sleep(50)
  // m2 may have arrived in the same batch or stay pending for the next wait
  const rest = items.length === 2 ? [] : await waitInbox(inbox.path)
  assert.deepEqual([...items, ...rest].map(i => i.id), ['m1', 'm2'])
  await sleep(50)
  assert.deepEqual(confirmed, ['m1', 'm2'])
})

test('a waiter that dies before ack leaves its messages for the next one', async t => {
  const confirmed = []
  const inbox = await createInbox({ path: tmpPath(), onConfirm: item => confirmed.push(item.id) })
  t.after(() => inbox.close())
  inbox.push(msg('m1'))
  await new Promise(resolve => {
    const s = connect(inbox.path)
    s.once('data', () => { s.destroy(); resolve() })
  })
  await sleep(50)
  assert.deepEqual(confirmed, [])
  const items = await waitInbox(inbox.path)
  assert.deepEqual(items.map(i => i.id), ['m1'])
  await sleep(50)
  assert.deepEqual(confirmed, ['m1'])
})

test('a newer waiter replaces an older one; the older gets nothing', async t => {
  const inbox = await createInbox({ path: tmpPath(), onConfirm: () => {} })
  t.after(() => inbox.close())
  const older = waitInbox(inbox.path)
  await sleep(50)
  const newer = waitInbox(inbox.path)
  assert.deepEqual(await older, [])
  await sleep(50)
  inbox.push(msg('m1'))
  assert.deepEqual((await newer).map(i => i.id), ['m1'])
})

test('notices pass through and are not confirmed', async t => {
  const confirmed = []
  const inbox = await createInbox({ path: tmpPath(), onConfirm: item => confirmed.push(item) })
  t.after(() => inbox.close())
  inbox.push({ notice: 'renamed' })
  assert.deepEqual(await waitInbox(inbox.path), [{ notice: 'renamed' }])
  await sleep(50)
  assert.deepEqual(confirmed, [])
})

test('a stale socket file is replaced', { skip: process.platform === 'win32' }, async t => {
  const path = tmpPath()
  writeFileSync(path, '')
  const inbox = await createInbox({ path, onConfirm: () => {} })
  t.after(() => inbox.close())
  inbox.push(msg('m1'))
  assert.equal((await waitInbox(path))[0].id, 'm1')
})

test('wait fails clearly when no inbox is listening', async () => {
  await assert.rejects(waitInbox(tmpPath()), /inbox not found/)
})

test('wait fails clearly when the inbox closes', async () => {
  const inbox = await createInbox({ path: tmpPath(), onConfirm: () => {} })
  const waiting = waitInbox(inbox.path)
  await sleep(50)
  await inbox.close()
  await assert.rejects(waiting, /inbox closed/)
})
