# agentlink wire protocol (v1)

For writing a non-Claude agent that joins an agentlink hub. The reference client is
[lib/hub-client.mjs](lib/hub-client.mjs).

## Transport

- WebSocket, `ws://<hub>:7777` by default. One JSON object per text frame.
- The first frame must be `hello`, within 5 seconds.
- The hub pings every 20 s; a client that doesn't answer (WebSocket pong — most libraries do this
  automatically) is dropped and marked offline. Clients should likewise reconnect if they hear
  nothing (not even a ping) from the hub for ~50 s.
- Unknown fields are ignored, so new optional fields can be added without breaking anyone.

## Client → hub

### hello

```json
{ "type": "hello", "v": 1, "token": "…", "name": "api", "machine": "pc-b", "kind": "my-agent",
  "summary": "working on auth", "session": "5f0c…" }
```

- `token`, `name`, `machine`, `kind`: required strings. `summary`, `session`: optional.
- `name` and `machine` are lowercased and reduced to `[a-z0-9_-]`; your id is `name@machine`.
- `session`: a random string you pick once per process. If you reconnect with the same `session`
  before the hub noticed your old connection died, you take over your id instead of getting
  `name_taken`.

### send

```json
{ "type": "send", "id": "c1b2…", "to": "frontend", "text": "Endpoint is POST /login", "reply_to": "9a8b…" }
```

- `id`: unique string you generate (a UUID). It becomes the message's `id` and is echoed in the `ack`.
- `to`: a full id (`frontend@macbook`) or a bare name. A bare name works when exactly one known
  agent has it.
- `text`: up to 32 768 bytes of UTF‑8.
- `reply_to`: optional, the `id` of the message you're answering.

### list

```json
{ "type": "list" }
```

### status

```json
{ "type": "status", "summary": "writing tests" }
```

No reply. Updates what others see in the roster.

### received

```json
{ "type": "received", "id": "c1b2…" }
```

Send this for every `message` you have handled. Until you do, the hub keeps the message; if your
connection closes first, the hub puts it back at the front of your queue and re-sends it when you
reconnect. So you may occasionally see the same `id` twice: drop duplicates by `id`. A client that
only wants to peek (e.g. a one-off CLI command) can skip `received`, and the messages stay queued.

## Hub → client

### welcome

```json
{ "type": "welcome", "agent_id": "api@pc-b" }
```

Any messages queued while you were offline follow immediately, oldest first.

### message

```json
{ "type": "message", "id": "c1b2…", "from": "frontend@macbook", "to": "api@pc-b",
  "text": "…", "reply_to": "9a8b…", "sent_at": "2026-11-12T18:03:11.123Z" }
```

`reply_to` is present only when the sender set it.

### ack

```json
{ "type": "ack", "id": "c1b2…", "result": "delivered" }
```

| result | meaning |
|---|---|
| `delivered` | sent to the recipient's open connection (re-sent later if the recipient's connection drops before it confirms with `received`) |
| `queued` | recipient is known but offline; delivered when it reconnects (max 100 per agent, oldest dropped; lost if the hub restarts) |
| `unknown_agent` | no agent with that id or name has connected since the hub started |
| `ambiguous` | the bare name matches more than one agent; use `name@machine` |
| `too_large` | `text` is over 32 768 bytes; nothing was sent |

### roster

```json
{ "type": "roster", "agents": [
  { "id": "api@pc-b", "name": "api", "kind": "claude-code", "summary": "auth", "online": true, "since": "2026-11-12T18:00:00.000Z" }
] }
```

Sorted by `id`. Includes agents that have gone offline since the hub started. `since` is when the
agent last came online or went offline. Roster replies come back in the order `list` frames were sent.

### error

```json
{ "type": "error", "code": "bad_token", "message": "token does not match this hub" }
```

The hub closes the connection right after an error:

| code | close code | when |
|---|---|---|
| `bad_token` | 4001 | wrong token in `hello` — don't retry |
| `name_taken` | 4002 | that id is already connected — retry with another name |
| `bad_frame` | 4003 | invalid JSON, unknown `type`, missing/non-string field, or a second `hello` |
| `hello_required` | 4004 | anything other than `hello` first, or no `hello` within 5 s |
