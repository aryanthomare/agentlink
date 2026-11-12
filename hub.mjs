#!/usr/bin/env node
// agentlink hub: routes messages between agents, keeps the roster, queues for offline agents.
import { once } from 'node:events'
import { timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { loadConfig, sanitize } from './lib/config.mjs'
import { CLOSE, DEFAULT_PORT, MAX_TEXT_BYTES, QUEUE_LIMIT, agentId, parseFrame } from './lib/protocol.mjs'

const tokenMatches = (given, expected) => {
  const a = Buffer.from(String(given).trim())
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function createHub({ token, port = DEFAULT_PORT, host = '0.0.0.0', pingMs = 20000, helloMs = 5000 } = {}) {
  if (!token) throw new Error('createHub: token is required')
  /** id -> { id, name, kind, summary, online, since, ws, queue } */
  const agents = new Map()
  const wss = new WebSocketServer({ port, host, maxPayload: 1024 * 1024 })
  await once(wss, 'listening')

  const sendJson = (ws, obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  }
  const reject = (ws, code, message, closeCode) => {
    sendJson(ws, { type: 'error', code, message })
    ws.close(closeCode, code)
  }
  const roster = () =>
    [...agents.values()]
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .map(a => ({ id: a.id, name: a.name, kind: a.kind, summary: a.summary, online: isLive(a), since: a.since }))

  // A socket that has started closing can no longer receive; treat it as offline.
  const isLive = agent => agent.online && agent.ws?.readyState === agent.ws?.OPEN

  const resolve = to => {
    if (agents.has(to)) return { agent: agents.get(to) }
    const matches = [...agents.values()].filter(a => a.name === to)
    if (matches.length === 1) return { agent: matches[0] }
    return { result: matches.length ? 'ambiguous' : 'unknown_agent' }
  }

  const handleHello = (ws, frame) => {
    if (!tokenMatches(frame.token, token)) return reject(ws, 'bad_token', 'token does not match this hub', CLOSE.BAD_TOKEN)
    const name = sanitize(frame.name, 'agent')
    const id = agentId(name, sanitize(frame.machine, 'host'))
    const existing = agents.get(id)
    if (existing && isLive(existing)) return reject(ws, 'name_taken', `${id} is already connected`, CLOSE.NAME_TAKEN)
    const entry = existing ?? { id, name, queue: [] }
    Object.assign(entry, {
      kind: frame.kind,
      summary: frame.summary ?? entry.summary ?? '',
      online: true,
      since: new Date().toISOString(),
      ws,
    })
    agents.set(id, entry)
    ws.agent = entry
    sendJson(ws, { type: 'welcome', agent_id: id })
    for (const msg of entry.queue.splice(0)) sendJson(ws, msg)
  }

  const handleSend = (ws, frame) => {
    const ack = result => sendJson(ws, { type: 'ack', id: frame.id, result })
    if (Buffer.byteLength(frame.text, 'utf8') > MAX_TEXT_BYTES) return ack('too_large')
    const { agent, result } = resolve(frame.to)
    if (!agent) return ack(result)
    const msg = {
      type: 'message',
      id: frame.id,
      from: ws.agent.id,
      to: agent.id,
      text: frame.text,
      ...(frame.reply_to ? { reply_to: frame.reply_to } : {}),
      sent_at: new Date().toISOString(),
    }
    if (isLive(agent)) {
      sendJson(agent.ws, msg)
      return ack('delivered')
    }
    agent.queue.push(msg)
    if (agent.queue.length > QUEUE_LIMIT) agent.queue.splice(0, agent.queue.length - QUEUE_LIMIT)
    ack('queued')
  }

  wss.on('connection', ws => {
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })
    const helloTimer = setTimeout(() => {
      if (!ws.agent) reject(ws, 'hello_required', 'send hello first', CLOSE.HELLO_REQUIRED)
    }, helloMs)

    ws.on('message', raw => {
      const parsed = parseFrame(raw)
      if (!parsed.ok) return reject(ws, 'bad_frame', parsed.message, CLOSE.BAD_FRAME)
      const { frame } = parsed
      if (!ws.agent) {
        if (frame.type !== 'hello') return reject(ws, 'hello_required', 'send hello first', CLOSE.HELLO_REQUIRED)
        clearTimeout(helloTimer)
        return handleHello(ws, frame)
      }
      switch (frame.type) {
        case 'send': return handleSend(ws, frame)
        case 'list': return sendJson(ws, { type: 'roster', agents: roster() })
        case 'status': ws.agent.summary = frame.summary; return
        default: return reject(ws, 'bad_frame', 'already said hello', CLOSE.BAD_FRAME)
      }
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      const entry = ws.agent
      if (entry && entry.ws === ws) {
        entry.online = false
        entry.ws = null
        entry.since = new Date().toISOString()
      }
    })
    ws.on('error', () => {})
  })

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue }
      ws.isAlive = false
      ws.ping()
    }
  }, pingMs)

  return {
    port: wss.address().port,
    async close() {
      clearInterval(pinger)
      for (const ws of wss.clients) ws.terminate()
      await new Promise(r => wss.close(() => r()))
    },
  }
}

export function lanUrls(port) {
  return Object.values(networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => `ws://${i.address}:${port}`)
}

export async function runHub() {
  const config = loadConfig()
  const hub = await createHub({ token: config.token, port: config.port })
  console.error(`agentlink hub listening on :${hub.port}`)
  for (const url of lanUrls(hub.port)) console.error(`  reachable at ${url}`)
  const stop = async () => { await hub.close(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return hub
}

const isMain = () => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}
if (isMain()) {
  runHub().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
