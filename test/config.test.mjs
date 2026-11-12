import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, initConfig } from '../lib/config.mjs'

const freshHome = () => mkdtempSync(join(tmpdir(), 'agentlink-home-'))
const writeFile = (home, obj) => {
  mkdirSync(join(home, '.agentlink'), { recursive: true })
  writeFileSync(join(home, '.agentlink', 'config.json'), JSON.stringify(obj))
}

test('defaults name to folder and machine to short hostname', () => {
  const home = freshHome()
  const c = loadConfig({ env: { AGENTLINK_TOKEN: 't' }, home, cwd: '/x/My App!', hostname: 'Aryans-MBP.local' })
  assert.equal(c.name, 'my-app')
  assert.equal(c.machine, 'aryans-mbp')
  assert.equal(c.hub, 'ws://127.0.0.1:7777')
  assert.equal(c.port, 7777)
})

test('env overrides file', () => {
  const home = freshHome()
  writeFile(home, { hub: 'ws://10.0.0.5:7777', token: 'filetok' })
  const c = loadConfig({ env: { AGENTLINK_HUB: 'ws://h:1', AGENTLINK_NAME: 'API' }, home, cwd: '/x/y', hostname: 'h' })
  assert.equal(c.hub, 'ws://h:1')
  assert.equal(c.token, 'filetok')
  assert.equal(c.name, 'api')
})

test('trims pasted token', () => {
  const home = freshHome()
  writeFile(home, { token: '  abc\n' })
  assert.equal(loadConfig({ env: {}, home, cwd: '/x/y', hostname: 'h' }).token, 'abc')
})

test('throws without token', () => {
  const home = freshHome()
  assert.throws(() => loadConfig({ env: {}, home, cwd: '/x/y', hostname: 'h' }), /AGENTLINK_TOKEN/)
  assert.equal(loadConfig({ env: {}, home, cwd: '/x/y', hostname: 'h', requireToken: false }).token, '')
})

test('initConfig creates once', () => {
  const home = freshHome()
  const first = initConfig({ home })
  assert.equal(first.created, true)
  assert.ok(first.token.length >= 32)
  assert.equal(statSync(first.path).mode & 0o777, 0o600)
  const second = initConfig({ home })
  assert.equal(second.created, false)
  assert.equal(second.token, first.token)
})
