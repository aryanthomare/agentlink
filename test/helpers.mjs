// Test-only helpers: raw WebSocket connections to a hub with buffered frames.
import WebSocket from 'ws'

/** Open a raw connection. `next(type?)` resolves with the next buffered frame (of that type). */
export function open(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const buffer = []
  const waiters = []
  const closed = new Promise(resolve => ws.on('close', code => resolve({ code })))
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  const flush = () => {
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i]
      const idx = buffer.findIndex(f => !w.type || f.type === w.type)
      if (idx !== -1) {
        const [frame] = buffer.splice(idx, 1)
        clearTimeout(w.timer)
        waiters.splice(i--, 1)
        w.resolve(frame)
      }
    }
  }
  ws.on('message', raw => {
    buffer.push(JSON.parse(String(raw)))
    flush()
  })

  return {
    ws,
    opened,
    closed,
    buffer,
    sendFrame: obj => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
    next(type, ms = 2000) {
      return new Promise((resolve, reject) => {
        const w = { type, resolve, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1)
          reject(new Error(`timed out waiting for ${type ?? 'any'} frame`))
        }, ms) }
        waiters.push(w)
        flush()
      })
    },
    async close() {
      ws.close()
      await closed
    },
  }
}

/** Open + hello + wait for welcome. */
export async function connect(port, { token, name, machine = 'test', kind = 'test', summary } = {}) {
  const c = open(port)
  await c.opened
  c.sendFrame({ type: 'hello', v: 1, token, name, machine, kind, ...(summary ? { summary } : {}) })
  c.welcome = await c.next('welcome')
  return c
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))
