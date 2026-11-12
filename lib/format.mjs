// Human-readable text shared by the channel tools and the CLI.
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function formatRoster(agents, selfId) {
  if (!agents.length) return 'No agents connected.'
  return agents
    .map(a => {
      const id = a.id === selfId ? `${a.id} (you)` : a.id
      return [id, a.online ? 'online' : 'offline', a.kind, a.summary].filter(Boolean).join('  ')
    })
    .join('\n')
}

/** Text for a send result. `known` is the roster (used for unknown/ambiguous hints). */
export function resultText(result, to, known = []) {
  switch (result) {
    case 'delivered': return `Delivered to ${to}.`
    case 'queued': return `${to} is offline; the hub will deliver when it reconnects.`
    case 'unknown_agent': return `No agent named "${to}". Known: ${known.map(a => a.id).join(', ') || 'none'}.`
    case 'ambiguous': return `"${to}" matches several agents: ${known.filter(a => a.name === to).map(a => a.id).join(', ')}. Use the full name@machine.`
    case 'too_large': return 'Message too large (limit 32 KB).'
    default: return `Unexpected hub result: ${result}`
  }
}

/** True when the module at `metaUrl` is the script node was started with. */
export function isMain(metaUrl) {
  try {
    return metaUrl === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}
