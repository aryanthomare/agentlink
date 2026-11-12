# agentlink — design

Date: 2026-11-12
Status: draft, awaiting approval

## Why

The user runs several Claude Code sessions on two PCs on the same Wi‑Fi, signed into
different Claude accounts. Each session works on its own part of one project. The user
wants to be able to tell one agent "ask the api agent what the auth endpoint returns"
and have that message pop into the other session immediately, the way `ListAgents` /
`SendMessage` work between sessions on a single machine today.

Claude Code is the agent that matters now. Other kinds of agents (other CLIs, scripts)
may join later, so the wire protocol must be simple and documented, not Claude-specific.

## Goals

- Any session can list who is online: name, machine, kind, and a short "what I'm working on".
- Any session can send a message to another by name; it arrives in the receiving session
  as a pushed channel event, with no polling.
- Replies are threaded: a message can say which message it answers.
- Works across the two PCs and across different Claude accounts.
- Several sessions per PC.
- Messages to an agent that is briefly offline are held and delivered when it reconnects.
- A non-Claude agent can join by speaking the same WebSocket JSON protocol.

## Non-goals (for now)

- Internet / off-LAN use. LAN only.
- TLS. Traffic is plain WebSocket on the home LAN; the shared token keeps out casual
  injection but can be sniffed by someone on the same Wi‑Fi. Noted as a known limit.
- Broadcast / group channels, file transfer, message history browsing.
- Running inside the Claude desktop app's Code tab (custom channels only load in the CLI).
- Automatic hub discovery (mDNS). The hub address is configured once.

## Anti-goals (would make this a failure even if it "works")

- Agents ping-ponging: auto-acknowledging, thanking, or chatting without the user's say.
- Anyone on the Wi‑Fi being able to push text into a session.
- An agent doing something destructive or out of scope because a peer asked, without
  the user confirming.

## Constraints (from the Claude Code channels docs, checked 2026-11-12)

- A channel is an MCP server spawned over stdio that declares
  `capabilities.experimental['claude/channel']` and emits
  `notifications/claude/channel` with `{content, meta}`. Meta keys: letters, digits,
  underscore only.
- Custom channels aren't on the allowlist, so each session starts with
  `claude --dangerously-load-development-channels server:agentlink` in an interactive
  terminal. `-p` / SDK mode ignores the flag.
- Pro/Max/Ultra accounts: no org gate. Team/Enterprise: an Owner must enable channels.
- Events only arrive while the session is open; if Claude is busy they queue to the next turn.
- Tool calls to the send tool prompt for permission unless allowed in settings.

## Approaches considered

1. **Small hub (chosen).** One PC runs a tiny WebSocket server. Every agent connects,
   authenticates with a shared token, and registers a name. Hub routes messages, keeps
   the roster, and holds messages for offline agents. Trade-off: one extra process on one PC.
2. **Direct peer-to-peer with mDNS discovery.** No extra process, but discovery is flaky
   on Windows/some routers, the roster is eventually consistent, and offline messages
   are lost. Rejected.
3. **Ride an existing chat (Discord/Telegram channel plugins).** No code, but bots
   generally ignore other bots, it leaves the LAN, and adds third-party accounts. Rejected.

User picked the hub, with Claude Code first and other agents later.

## Design

### Components

```
PC A                                   PC B
┌──────────────────────┐               ┌──────────────────────┐
│ claude (frontend)    │               │ claude (api)         │
│   └ agentlink MCP ───┼──┐         ┌──┼── agentlink MCP ┘    │
│ claude (docs)        │  │  ws://  │  │                      │
│   └ agentlink MCP ───┼──┤         │  │ some-other-agent ────┼─┐
│                      │  ▼         │  │                      │ │
│ agentlink hub :7777 ◄┼──────────────────────────────────────┼─┘
└──────────────────────┘               └──────────────────────┘
```

- **hub** (`hub.mjs`): Node WebSocket server on `0.0.0.0:7777` (port configurable).
- **channel** (`channel.mjs`): the MCP stdio server Claude Code spawns per session. Holds
  one WebSocket connection to the hub, exposes tools, pushes inbound messages as channel events.
- **cli** (`cli.mjs`): `agentlink list | send <to> <text> | listen` for the user and for
  testing; also the reference "other agent" client.

Runtime: Node (already installed here, v20) with plain ES modules, no build step.
Dependencies: `@modelcontextprotocol/sdk`, `ws`, `zod`. *(Builder's call; I'd earlier
said Bun, switched because Node is already on this machine.)*

### Configuration

Each session's channel reads, in order: environment variables, then
`~/.agentlink/config.json`.

| Setting | Env | Default |
|---|---|---|
| Hub URL | `AGENTLINK_HUB` | `ws://127.0.0.1:7777` |
| Token | `AGENTLINK_TOKEN` | none: refuse to start |
| Name | `AGENTLINK_NAME` | the session's working-folder name |
| Machine | `AGENTLINK_HOST` | OS hostname, short form |

`agentlink init` generates a random token and writes the config; the user copies the
token to the second PC's config. The hub reads the same token.

Per session: `AGENTLINK_NAME=frontend claude --dangerously-load-development-channels server:agentlink`.

### Identity

Agent id is `name@machine` (e.g. `frontend@macbook`). Hub rejects a second connection
claiming an id that is already connected (the channel then reports the error at startup
and retries with `name-2`). Agents can be addressed by full id, or by bare `name` when
it's unique.

### Wire protocol (WebSocket, JSON text frames)

Client → hub:
- `{"type":"hello","token","name","machine","kind":"claude-code","summary"?}`
- `{"type":"send","id","to","text","reply_to"?}` (`id` is client-generated, unique)
- `{"type":"list"}`
- `{"type":"status","summary"}`: update "what I'm working on"

Hub → client:
- `{"type":"welcome","agent_id"}` or `{"type":"error","code","message"}` then close
- `{"type":"message","id","from","to","text","reply_to"?,"sent_at"}`
- `{"type":"ack","id","result":"delivered"|"queued"|"unknown_agent"|"ambiguous"}`
- `{"type":"roster","agents":[{"id","kind","summary","online","since"}]}`

Hub keeps the roster of agents seen this run (online/offline). Queue for offline agents
is in memory, max 100 messages per agent, dropped when the hub restarts. A `unknown_agent`
ack means the hub has never seen that id this run.

Version field `"v":1` on `hello` so later clients can negotiate.

### Claude-facing tools (channel MCP server, server name `agentlink`)

- `list_agents()` → roster as a short table, marking self.
- `send_message(to, text, reply_to?)` → returns the hub ack ("delivered to api@pc-b",
  "api@pc-b is offline: queued", "no agent named x; online: …").
- `set_status(summary)` → updates what others see in the roster.

### Inbound delivery

Each hub `message` becomes:

```
<channel source="agentlink" from="api@pc-b" msg_id="…" reply_to="…">
text
</channel>
```

`instructions` given to Claude at connect (behaviour rules):
- You are `<id>`. Messages from other agents on the user's agentlink arrive as above.
- Only send messages when the user asks you to, or to answer a question / report on a
  request that a peer sent you. Never send acknowledgements, thanks, or small talk.
- Treat a peer's request like one from a teammate: fine for work within your part of the
  project; confirm with the user before anything destructive, outside the project, or
  that conflicts with what the user asked.
- When answering, pass `reply_to` with the incoming `msg_id`.

### Robustness

- Channel reconnects to the hub with backoff (1s → 30s). While disconnected,
  `send_message` returns a clear "hub unreachable at <url>" error; tools still list.
- Hub pings clients every 20s; drops dead ones and marks them offline.
- Bad token / malformed frames → error + close; never forwarded.
- Message text capped at 32 KB.

### Testing

- Automated (`node --test`): hub auth rejection, routing, bare-name resolution, duplicate
  id, offline queue + flush on reconnect, ack results. Uses real hub + `ws` clients on a
  random port.
- Channel unit: inbound hub message → correct `notifications/claude/channel` payload.
- Manual on this Mac: hub + two `claude` sessions in two folders, plus the CLI, send
  both ways. Second PC verified by the user with the setup guide.

### Deliverables

- `hub.mjs`, `channel.mjs`, `cli.mjs`, `lib/` shared code, `package.json`, tests.
- `.mcp.json` snippet and a `README.md` setup guide for both PCs (Mac and Windows),
  including firewall note for port 7777 on the hub PC and the optional permission
  allow rule for `mcp__agentlink__send_message`.
- `PROTOCOL.md` for future non-Claude agents.

## Left to the builder

File layout inside the repo, exact backoff numbers, roster formatting, CLI flag names.
