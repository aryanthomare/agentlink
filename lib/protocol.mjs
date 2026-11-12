// Wire protocol shared by the hub and all clients. See PROTOCOL.md.

export const PROTOCOL_VERSION = 1
export const DEFAULT_PORT = 7777
export const MAX_TEXT_BYTES = 32768
export const QUEUE_LIMIT = 100
export const CLOSE = { BAD_TOKEN: 4001, NAME_TAKEN: 4002, BAD_FRAME: 4003, HELLO_REQUIRED: 4004 }
export const ACK_RESULTS = ['delivered', 'queued', 'unknown_agent', 'ambiguous', 'too_large']

export const agentId = (name, machine) => `${name}@${machine}`

const REQUIRED = {
  hello: ['token', 'name', 'machine', 'kind'],
  send: ['id', 'to', 'text'],
  list: [],
  status: ['summary'],
}
const OPTIONAL = {
  hello: ['summary'],
  send: ['reply_to'],
  list: [],
  status: [],
}

/** Validate a client→hub frame. Unknown fields are ignored. */
export function parseFrame(raw) {
  let frame
  try {
    frame = JSON.parse(String(raw))
  } catch {
    return { ok: false, message: 'frame is not valid JSON' }
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    return { ok: false, message: 'frame must be a JSON object' }
  }
  const required = REQUIRED[frame.type]
  if (!required) return { ok: false, message: `unknown frame type ${JSON.stringify(frame.type)}` }
  for (const key of required) {
    if (typeof frame[key] !== 'string') return { ok: false, message: `${frame.type}.${key} must be a string` }
  }
  for (const key of OPTIONAL[frame.type]) {
    if (frame[key] !== undefined && typeof frame[key] !== 'string') {
      return { ok: false, message: `${frame.type}.${key} must be a string` }
    }
  }
  return { ok: true, frame }
}
