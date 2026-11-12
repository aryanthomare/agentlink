import os from 'node:os'
import { basename, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

export const DEFAULT_HUB = 'ws://127.0.0.1:7777'
export const DEFAULT_PORT = 7777

/** Lowercase, keep [a-z0-9_-], collapse everything else to '-'. */
export function sanitize(s, fallback) {
  const out = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return out || fallback
}

/** Accept "192.168.1.5", "192.168.1.5:8000" or a full ws:// URL. */
export function normalizeHub(raw) {
  let s = String(raw ?? '').trim()
  if (!s) return DEFAULT_HUB
  if (!/^wss?:\/\//i.test(s)) s = `ws://${s}`
  if (!/^wss?:\/\/(\[[^\]]+\]|[^/:]+):\d+/i.test(s)) s = s.replace(/^(wss?:\/\/(\[[^\]]+\]|[^/:]+))/i, `$1:${DEFAULT_PORT}`)
  return s
}

export function configPath(home = os.homedir()) {
  return join(home, '.agentlink', 'config.json')
}

function readFileConfig(home) {
  const p = configPath(home)
  if (!existsSync(p)) return {}
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    throw new Error(`agentlink: could not parse ${p}: ${err.message}`)
  }
}

export function loadConfig({
  env = process.env,
  home = os.homedir(),
  cwd = process.cwd(),
  hostname = os.hostname(),
  requireToken = true,
} = {}) {
  const file = readFileConfig(home)
  const pick = (envKey, fileKey) => {
    const v = env[envKey]
    return v !== undefined && v !== '' ? v : file[fileKey]
  }
  const token = String(pick('AGENTLINK_TOKEN', 'token') ?? '').trim()
  if (!token && requireToken) {
    throw new Error(
      `agentlink: no token. Set AGENTLINK_TOKEN or run "agentlink init" (writes ${configPath(home)}).`,
    )
  }
  const portRaw = pick('AGENTLINK_PORT', 'port')
  const port = Number.parseInt(portRaw ?? DEFAULT_PORT, 10) || DEFAULT_PORT
  return {
    hub: normalizeHub(pick('AGENTLINK_HUB', 'hub')),
    token,
    port,
    name: sanitize(env.AGENTLINK_NAME || basename(cwd), 'agent'),
    machine: sanitize(env.AGENTLINK_HOST || String(hostname).split('.')[0], 'host'),
  }
}

export function initConfig({ home = os.homedir(), hub, token: givenToken } = {}) {
  const p = configPath(home)
  const wanted = givenToken ? String(givenToken).trim() : undefined
  if (existsSync(p)) {
    const existing = readFileConfig(home)
    const next = { ...existing, ...(hub ? { hub } : {}), ...(wanted ? { token: wanted } : {}) }
    if (next.hub !== existing.hub || next.token !== existing.token) {
      writeFileSync(p, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    }
    return { path: p, token: String(next.token ?? '').trim(), created: false }
  }
  mkdirSync(join(home, '.agentlink'), { recursive: true })
  const token = wanted ?? randomBytes(24).toString('base64url')
  writeFileSync(p, JSON.stringify({ hub: hub ?? DEFAULT_HUB, token }, null, 2) + '\n', { mode: 0o600 })
  chmodSync(p, 0o600)
  return { path: p, token, created: true }
}
