#!/usr/bin/env node
// agentlink CLI: set up config, run the hub, and send/list/listen from a terminal.
import { initConfig, loadConfig } from './lib/config.mjs'
import { HubClient } from './lib/hub-client.mjs'
import { formatRoster, resultText } from './lib/format.mjs'
import { runHub } from './hub.mjs'

const USAGE = `usage:
  agentlink init [--hub ws://IP:7777]   create ~/.agentlink/config.json with a new token
  agentlink hub                         run the hub on this PC
  agentlink list                        show agents on the hub
  agentlink send <to> <text...>         send a message
  agentlink listen                      print incoming messages until Ctrl-C`

const fail = msg => {
  console.error(msg)
  process.exit(1)
}

async function connected() {
  let config
  try { config = loadConfig() } catch (err) { fail(err.message) }
  const client = new HubClient({
    url: config.hub,
    token: config.token,
    name: process.env.AGENTLINK_NAME ? config.name : 'cli',
    machine: config.machine,
    kind: 'cli',
  })
  const timeoutMs = Number(process.env.AGENTLINK_CONNECT_TIMEOUT_MS) || 5000
  await new Promise(resolve => {
    const timer = setTimeout(() => fail(`hub unreachable at ${config.hub} (is the hub running, and is the IP/port right?)`), timeoutMs)
    client.once('welcome', () => { clearTimeout(timer); resolve() })
    client.once('fatal', err => fail(err.message))
    client.start()
  })
  return client
}

async function main([cmd, ...args]) {
  switch (cmd) {
    case 'init': {
      const i = args.indexOf('--hub')
      const hub = i !== -1 ? args[i + 1] : undefined
      if (i !== -1 && !hub) fail('--hub needs a URL like ws://192.168.1.20:7777')
      const { path, token, created } = initConfig({ hub })
      console.log(created ? `Created ${path}` : `${path} already exists (token unchanged${hub ? ', hub updated' : ''})`)
      console.log(`token: ${token}`)
      console.log('Copy this token into ~/.agentlink/config.json on the other PC (same "token", and "hub" pointing at the hub PC).')
      return
    }
    case 'hub':
      await runHub()
      return
    case 'list': {
      const client = await connected()
      console.log(formatRoster(await client.list(), client.agentId))
      await client.stop()
      return
    }
    case 'send': {
      const [to, ...words] = args
      if (!to || !words.length) fail('usage: agentlink send <to> <text...>')
      const client = await connected()
      const result = await client.send({ to, text: words.join(' ') })
      const known = result === 'unknown_agent' || result === 'ambiguous' ? await client.list().catch(() => []) : []
      const line = resultText(result, to, known)
      await client.stop()
      if (result === 'delivered' || result === 'queued') console.log(line)
      else fail(line)
      return
    }
    case 'listen': {
      const client = await connected()
      console.error(`listening as ${client.agentId} (Ctrl-C to stop)`)
      client.on('message', m => console.log(`[${m.from}] ${m.text}`))
      client.on('disconnected', () => console.error('hub disconnected, reconnecting…'))
      client.on('welcome', id => console.error(`reconnected as ${id}`))
      process.on('SIGINT', async () => { await client.stop(); process.exit(0) })
      return
    }
    default:
      console.log(USAGE)
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exit(1)
  }
}

main(process.argv.slice(2)).catch(err => fail(err.message))
