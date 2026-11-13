// Local inbox for Claude sessions that can't receive channel pushes (the Claude desktop app).
// The channel keeps incoming messages here; `agentlink wait` connects, takes every pending
// message once there is at least one, prints them and answers "ok". Only then are the messages
// confirmed to the hub. Wire format: the inbox writes one JSON array line, the waiter answers "ok".
import { createServer, connect } from 'node:net'
import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export function inboxPath(id, { home = homedir(), platform = process.platform } = {}) {
  return platform === 'win32' ? `\\\\.\\pipe\\agentlink-${id}` : join(home, '.agentlink', 'run', `${id}.sock`)
}

const isPipe = path => path.startsWith('\\\\.\\pipe\\')

/** onConfirm(item) runs for each message (not notices) once a waiter has acknowledged it. */
export async function createInbox({ path, onConfirm }) {
  const pending = []
  let waiter = null // { sock, batch }

  const flush = () => {
    if (!waiter || waiter.batch || !pending.length) return
    waiter.batch = pending.splice(0)
    waiter.sock.write(JSON.stringify(waiter.batch) + '\n')
  }

  const server = createServer(sock => {
    if (waiter) {
      // a newer `wait` replaces the older one; give the older one nothing
      const old = waiter
      waiter = null
      if (old.batch) pending.unshift(...old.batch)
      old.batch = null
      old.sock.end('[]\n')
    }
    const me = { sock, batch: null }
    waiter = me
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', d => {
      buf += d
      if (!buf.includes('\n') || !me.batch) return
      if (buf.split('\n')[0].trim() !== 'ok') return sock.destroy()
      const batch = me.batch
      me.batch = null
      if (waiter === me) waiter = null
      sock.end()
      for (const item of batch) if (item.id) onConfirm(item)
    })
    sock.on('close', () => {
      if (me.batch) pending.unshift(...me.batch) // died before acknowledging
      me.batch = null
      if (waiter === me) waiter = null
      flush()
    })
    sock.on('error', () => {})
    flush()
  })

  if (!isPipe(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    rmSync(path, { force: true }) // stale file from a crashed session
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.off('error', reject); resolve() })
  })

  return {
    path,
    get pending() { return pending.length },
    push(item) {
      pending.push(item)
      flush()
    },
    async close() {
      waiter?.sock.destroy()
      waiter = null
      await new Promise(resolve => server.close(() => resolve()))
      if (!isPipe(path)) rmSync(path, { force: true })
    },
  }
}

/**
 * Wait for the next batch from the inbox at `path`. `handle(items)` runs before the inbox is told
 * "ok", so print there: if this process dies first, the messages stay in the inbox.
 */
export function waitInbox(path, handle = () => {}) {
  return new Promise((resolve, reject) => {
    const sock = connect(path)
    let buf = ''
    let got = false
    sock.setEncoding('utf8')
    sock.on('error', err => {
      if (got) return
      got = true
      reject(['ENOENT', 'ECONNREFUSED'].includes(err.code)
        ? new Error(`agentlink inbox not found at ${path} (has the Claude session that owns it ended?)`)
        : err)
    })
    sock.on('data', d => {
      buf += d
      if (got || !buf.includes('\n')) return
      got = true
      let items
      try { items = JSON.parse(buf.slice(0, buf.indexOf('\n'))) } catch (err) { sock.destroy(); return reject(err) }
      if (!items.length) { sock.end(); return resolve(items) }
      try { handle(items) } catch (err) { sock.destroy(); return reject(err) }
      sock.end('ok\n')
      resolve(items)
    })
    sock.on('close', () => {
      if (got) return
      got = true
      reject(new Error('agentlink inbox closed (the Claude session ended or restarted)'))
    })
  })
}
