#!/usr/bin/env node
// agentlink CLI: set up config, run the hub, and send/list/listen from a terminal.
import { createInterface } from 'node:readline'
import { initConfig, loadConfig, normalizeHub } from './lib/config.mjs'
import { HubClient } from './lib/hub-client.mjs'
import { formatRoster, resultText } from './lib/format.mjs'
import { runHub } from './hub.mjs'
import { waitInbox } from './lib/inbox.mjs'

function formatBatch(items) {
  const out = []
  const n = items.filter(i => i.id).length
  if (n) out.push(`agentlink: ${n} new message${n === 1 ? '' : 's'}`)
  for (const i of items) {
    if (i.notice) out.push('', `<<< notice from agentlink >>>`, i.notice, '<<< end >>>')
    else out.push('', `<<< message from ${i.from} · msg_id ${i.id}${i.reply_to ? ` · reply_to ${i.reply_to}` : ''} >>>`, i.text, '<<< end >>>')
  }
  out.push('', 'Handle these under the agentlink rules (answer with send_message, to = the sender, reply_to = the msg_id), then start this same wait command again in the background so you keep receiving messages.')
  return out.join('\n')
}

const USAGE = `usage:
  agentlink init [--hub IP[:port]] [--token T]  write ~/.agentlink/config.json
                                         (hub PC: no --token, a new one is made;
                                          other PC: --token <token from the hub PC>)
  agentlink hub                          run the hub on this PC
  agentlink list                         show agents on the hub
  agentlink send <to> <text...>          one-off message (replies go to "cli"; see chat)
  agentlink wait <inbox>                 (for Claude desktop sessions) wait for messages,
                                         print them and exit
  agentlink chat                         talk from this terminal: type "@name message";
                                         incoming messages are printed. Ctrl-C to quit`

const fail = msg => {
  console.error(msg)
  process.exit(1)
}

async function connected({ confirm = true } = {}) {
  let config
  try { config = loadConfig() } catch (err) { fail(err.message) }
  const client = new HubClient({
    url: config.hub,
    token: config.token,
    name: process.env.AGENTLINK_NAME ? config.name : 'cli',
    machine: config.machine,
    kind: 'cli',
    confirm,
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
      const flag = name => {
        const i = args.indexOf(name)
        if (i === -1) return undefined
        if (!args[i + 1]) fail(`${name} needs a value`)
        return args[i + 1]
      }
      const hub = flag('--hub')
      const given = flag('--token')
      const { path, token, created } = initConfig({ hub: hub && normalizeHub(hub), token: given })
      console.log(created ? `Created ${path}` : `Updated ${path}`)
      if (given) {
        console.log('Saved the token from the hub PC. Check the link with: agentlink list')
      } else {
        console.log(`token: ${token}`)
        console.log(`On the other PC run: agentlink init --hub <this PC's IP> --token ${token}`)
      }
      return
    }
    case 'hub':
      await runHub()
      return
    case 'list': {
      const client = await connected({ confirm: false })
      console.log(formatRoster(await client.list(), client.agentId))
      await client.stop()
      return
    }
    case 'send': {
      const [to, ...words] = args
      if (!to || !words.length) fail('usage: agentlink send <to> <text...>')
      const client = await connected({ confirm: false })
      const result = await client.send({ to, text: words.join(' ') })
      const known = result === 'unknown_agent' || result === 'ambiguous' ? await client.list().catch(() => []) : []
      const line = resultText(result, to, known)
      await client.stop()
      if (result === 'delivered' || result === 'queued') console.log(line)
      else fail(line)
      return
    }
    case 'wait': {
      if (!args[0]) fail('usage: agentlink wait <inbox path>  (the agentlink tool instructions give the exact command)')
      try {
        const items = await waitInbox(args[0], batch => console.log(formatBatch(batch)))
        if (!items.length) console.log('agentlink: a newer wait command took over. Nothing to do; do not start another one.')
      } catch (err) {
        fail(err.message)
      }
      return
    }
    case 'chat':
    case 'listen': {
      const client = await connected()
      console.error(`chatting as ${client.agentId}. Type "@name message" to send; Ctrl-C to quit.`)
      client.on('message', m => console.log(`[${m.from}] ${m.text}`))
      client.on('disconnected', () => console.error('hub disconnected, reconnecting…'))
      client.on('welcome', id => console.error(`connected as ${id}`))
      const quit = async () => { await client.stop(); process.exit(0) }
      process.on('SIGINT', quit)
      const rl = createInterface({ input: process.stdin })
      rl.on('line', async line => {
        if (!line.trim()) return
        const m = /^@?([^\s:]+):?\s+([\s\S]+)$/.exec(line.trim())
        if (!m) return console.error('type "@name message"')
        try {
          const result = await client.send({ to: m[1], text: m[2] })
          if (result !== 'delivered') {
            const known = result === 'unknown_agent' || result === 'ambiguous' ? await client.list().catch(() => []) : []
            console.error(resultText(result, m[1], known))
          }
        } catch (err) {
          console.error(err.message)
        }
      })
      return
    }
    default:
      console.log(USAGE)
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exit(1)
  }
}

main(process.argv.slice(2)).catch(err => fail(err.message))
