import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHub } from '../hub.mjs'
import { HubClient } from '../lib/hub-client.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs')
const run = (args, env) =>
  new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    )
  })

test('send and list via CLI', async t => {
  const hub = await createHub({ token: 'tok', port: 0 })
  const web = new HubClient({ url: `ws://127.0.0.1:${hub.port}`, token: 'tok', name: 'web', machine: 'mac', kind: 'test' })
  t.after(async () => { await web.stop(); await hub.close() })
  const welcomed = once(web, 'welcome')
  web.start()
  await welcomed

  const env = { AGENTLINK_TOKEN: 'tok', AGENTLINK_HUB: `ws://127.0.0.1:${hub.port}`, HOME: mkdtempSync(join(tmpdir(), 'al-')) }
  const got = once(web, 'message')
  const sent = await run(['send', 'web', 'hello', 'from', 'cli'], env)
  assert.equal(sent.code, 0, sent.stderr)
  assert.match(sent.stdout, /Delivered to web\./)
  assert.equal((await got)[0].text, 'hello from cli')

  const listed = await run(['list'], env)
  assert.equal(listed.code, 0, listed.stderr)
  assert.match(listed.stdout, /web@mac/)

  const dead = await run(['send', 'web', 'x'], { ...env, AGENTLINK_HUB: 'ws://127.0.0.1:1', AGENTLINK_CONNECT_TIMEOUT_MS: '500' })
  assert.equal(dead.code, 1)
  assert.match(dead.stderr, /hub unreachable/)
})

test('init writes config and prints token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'al-'))
  const out = await run(['init', '--hub', 'ws://10.0.0.9:7777'], { HOME: home })
  assert.equal(out.code, 0, out.stderr)
  const cfg = JSON.parse(readFileSync(join(home, '.agentlink', 'config.json'), 'utf8'))
  assert.equal(cfg.hub, 'ws://10.0.0.9:7777')
  assert.ok(out.stdout.includes(cfg.token))
  assert.match(out.stdout, /other PC/)
})
