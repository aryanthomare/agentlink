// Reconnecting client for the agentlink hub. Used by the Claude Code channel and the CLI.
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { PROTOCOL_VERSION } from './protocol.mjs'

export class HubClient extends EventEmitter {
  #opts
  #ws = null
  #agentId = null
  #stopped = true
  #fatal = false
  #delay
  #timer = null
  #suffix = 1
  #retryNow = false
  #summary
  #session = randomUUID()
  #acks = new Map()
  #lists = []
  #seen = new Set()
  #confirmed = new Set()
  #idleTimer = null

  /**
   * idleTimeoutMs: reconnect if nothing (not even a ping) arrives from the hub for this long.
   *   The hub pings every 20s, so the default allows two missed pings.
   * confirm: true sends `received` for each message. One-shot tools pass false so the hub keeps
   *   messages for the real recipient. 'manual' sends it only when the owner calls confirm(id).
   */
  constructor({ url, token, name, machine, kind = 'claude-code', summary = '', minBackoffMs = 1000, maxBackoffMs = 30000, timeoutMs = 5000, idleTimeoutMs = 50000, confirm = true }) {
    super()
    this.#opts = { url, token, name, machine, kind, minBackoffMs, maxBackoffMs, timeoutMs, idleTimeoutMs, confirm }
    this.#summary = summary
    this.#delay = minBackoffMs
  }

  get url() { return this.#opts.url }
  get agentId() { return this.#agentId }
  get connected() { return this.#agentId !== null && this.#ws?.readyState === WebSocket.OPEN }

  start() {
    if (!this.#stopped) return
    this.#stopped = false
    this.#fatal = false
    this.#connect()
  }

  async stop() {
    this.#stopped = true
    clearTimeout(this.#timer)
    clearTimeout(this.#idleTimer)
    const ws = this.#ws
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      // events.once() would reject on the 'error' ws emits when aborting a pending handshake
      const closed = new Promise(resolve => ws.once('close', resolve))
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate()
      else ws.close()
      await closed
    }
  }

  send({ to, text, reply_to }) {
    return this.#request(id => ({ type: 'send', id, to, text, ...(reply_to ? { reply_to } : {}) }), (id, entry) => this.#acks.set(id, entry))
  }

  list() {
    return this.#request(() => ({ type: 'list' }), (_id, entry) => this.#lists.push(entry))
  }

  /** confirm: 'manual' only. Tell the hub this message was handled. */
  confirm(id) {
    this.#remember(this.#confirmed, id)
    if (this.connected) this.#ws.send(JSON.stringify({ type: 'received', id }))
  }

  /** Reconnect under a new name. The old id shows as offline. */
  rename(name) {
    this.#opts.name = name
    this.#suffix = 1
    if (this.#ws && !this.#stopped) {
      this.#retryNow = true
      this.#ws.terminate()
    }
  }

  #remember(set, id) {
    set.add(id)
    if (set.size > 1000) set.delete(set.values().next().value)
  }

  setStatus(summary) {
    this.#summary = summary
    if (this.connected) this.#ws.send(JSON.stringify({ type: 'status', summary }))
  }

  #request(makeFrame, register) {
    if (!this.connected) return Promise.reject(new Error(`hub unreachable at ${this.url}`))
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const entry = { resolve, reject, timer: null }
      entry.timer = setTimeout(() => {
        this.#acks.delete(id)
        const i = this.#lists.indexOf(entry)
        if (i !== -1) this.#lists.splice(i, 1)
        reject(new Error(`hub did not answer within ${this.#opts.timeoutMs / 1000}s; reconnecting`))
        this.#ws?.terminate() // a silent hub usually means a dead connection
      }, this.#opts.timeoutMs)
      register(id, entry)
      this.#ws.send(JSON.stringify(makeFrame(id)))
    })
  }

  #currentName() {
    return this.#suffix > 1 ? `${this.#opts.name}-${this.#suffix}` : this.#opts.name
  }

  #connect() {
    let ws
    try {
      ws = new WebSocket(this.#opts.url)
    } catch (err) {
      this.#fatal = true
      this.emit('fatal', new Error(`bad hub address ${JSON.stringify(this.#opts.url)}: ${err.message}`))
      return
    }
    this.#ws = ws
    const alive = () => {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = setTimeout(() => ws.terminate(), this.#opts.idleTimeoutMs)
    }
    ws.on('ping', alive)
    ws.on('message', alive)
    ws.on('open', () => {
      alive()
      ws.send(JSON.stringify({
        type: 'hello',
        v: PROTOCOL_VERSION,
        token: this.#opts.token,
        name: this.#currentName(),
        machine: this.#opts.machine,
        kind: this.#opts.kind,
        summary: this.#summary,
        session: this.#session,
      }))
    })
    ws.on('message', raw => {
      let frame
      try { frame = JSON.parse(String(raw)) } catch { return }
      this.#onFrame(frame)
    })
    ws.on('close', () => this.#onClose(ws))
    ws.on('error', () => {})
  }

  #onFrame(frame) {
    switch (frame.type) {
      case 'welcome':
        this.#agentId = frame.agent_id
        this.#delay = this.#opts.minBackoffMs
        this.emit('welcome', frame.agent_id)
        return
      case 'message': {
        if (!this.#seen.has(frame.id)) {
          this.#remember(this.#seen, frame.id)
          this.emit('message', frame)
        }
        const confirm = this.#opts.confirm === 'manual' ? this.#confirmed.has(frame.id) : this.#opts.confirm
        if (confirm && this.connected) this.#ws.send(JSON.stringify({ type: 'received', id: frame.id }))
        return
      }
      case 'ack': {
        const entry = this.#acks.get(frame.id)
        if (!entry) return
        this.#acks.delete(frame.id)
        clearTimeout(entry.timer)
        entry.resolve(frame.result)
        return
      }
      case 'roster': {
        const entry = this.#lists.shift()
        if (!entry) return
        clearTimeout(entry.timer)
        entry.resolve(frame.agents)
        return
      }
      case 'error':
        if (frame.code === 'bad_token') {
          this.#fatal = true
          this.emit('fatal', new Error(`hub rejected the token (${this.url}). Check AGENTLINK_TOKEN on both PCs.`))
        } else if (frame.code === 'name_taken') {
          this.#suffix++
          this.#retryNow = true
        }
        return
    }
  }

  #onClose(ws) {
    if (ws !== this.#ws) return
    clearTimeout(this.#idleTimer)
    const wasWelcomed = this.#agentId !== null
    this.#agentId = null
    const lost = new Error(`hub connection lost (${this.url})`)
    for (const entry of [...this.#acks.values(), ...this.#lists.splice(0)]) {
      clearTimeout(entry.timer)
      entry.reject(lost)
    }
    this.#acks.clear()
    if (wasWelcomed) this.emit('disconnected')
    if (this.#stopped || this.#fatal) return
    if (this.#retryNow) {
      this.#retryNow = false
      return this.#connect()
    }
    const delay = this.#delay
    this.#delay = Math.min(this.#delay * 2, this.#opts.maxBackoffMs)
    this.#timer = setTimeout(() => this.#connect(), delay)
  }
}
