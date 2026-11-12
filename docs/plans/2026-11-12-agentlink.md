# agentlink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Code sessions on two LAN PCs (different Claude accounts) list each other and send messages that arrive instantly as channel events, through a small hub.

**Architecture:** `hub.mjs` is a WebSocket router with a roster and per-agent offline queue. `lib/hub-client.mjs` is a reconnecting client used by both the Claude Code channel (`channel.mjs`, an MCP stdio server declaring `claude/channel`) and the `cli.mjs` test/reference client. Config comes from env, then `~/.agentlink/config.json`.

**Tech Stack:** Node ≥ 20 (ES modules, no build), `@modelcontextprotocol/sdk@1.32.2`, `ws@8.23.0`, tests with `node:test` + `node:assert/strict`.

**Spec:** `docs/specs/2026-11-12-agentlink-design.md`

## Global Constraints

- Node ≥ 20, plain `.mjs`, no TypeScript, no build step. Dependencies: exactly `@modelcontextprotocol/sdk` pinned `1.32.2` and `ws` pinned `8.23.0`. No zod (hand-written frame validation).
- MCP SDK must stay on **1.x**: SDK 2.x negotiates protocol revision 2026-07-28, and Claude Code refuses to register such a server as a channel.
- Channel server must never write to stdout except through the MCP transport. All logs go to `process.stderr`.
- MCP server name: `agentlink`. Channel capability: `capabilities.experimental['claude/channel'] = {}`; `capabilities.tools = {}`. No permission-relay capability.
- Channel `meta` keys: letters, digits, underscore only (`from`, `msg_id`, `reply_to`).
- Defaults: hub port `7777`, hub URL `ws://127.0.0.1:7777`, ping interval 20 s, backoff 1 s → 30 s, offline queue 100 per agent (drop oldest), text cap 32 768 bytes (UTF‑8), request timeout 5 s, hello timeout 5 s.
- Agent id format `name@machine`; name and machine sanitized to `[a-z0-9_-]`, lowercase.
- Wire protocol exactly as spec §"Wire protocol", plus `hello.v = 1` and ack result `too_large` (addition: oversized text gets an ack instead of a close).
- Close codes: `4001` bad_token, `4002` name_taken, `4003` bad_frame, `4004` hello_required.

## Review Focus

1. **Hub unreachable** (wrong IP, firewall on the hub PC): `send_message` must say `hub unreachable at <url>`, not hang. → test in Task 3.
2. **Hub restarts while sessions are open**: clients reconnect on their own, keep the same agent id and status, and can send again. → test in Task 3.
3. **Token pasted with trailing newline/spaces** from the other PC: still authenticates. → test in Task 1.
4. **Multi-line / emoji text and the byte cap**: text round-trips unchanged; the cap counts UTF‑8 bytes, not characters. → test in Task 2.
5. **Stray stdout in the channel process** corrupts MCP framing: the stdio integration test must run the real `channel.mjs` as a child process and see clean tool calls and notifications. → test in Task 4.

---

### Task 1: Scaffold and config

**Files:**
- Create: `package.json`, `.gitignore`, `lib/config.mjs`
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces:
  - `sanitize(s: string, fallback: string) -> string` — lowercase, replace runs of chars outside `[a-z0-9_-]` with `-`, trim `-`, fallback if empty.
  - `loadConfig({ env = process.env, home = os.homedir(), cwd = process.cwd(), hostname = os.hostname(), requireToken = true } = {}) -> { hub: string, token: string, port: number, name: string, machine: string }`. Reads `<home>/.agentlink/config.json` (keys `hub`, `token`, `port`) if present; env `AGENTLINK_HUB`, `AGENTLINK_TOKEN`, `AGENTLINK_PORT`, `AGENTLINK_NAME`, `AGENTLINK_HOST` override. `name` defaults to `sanitize(basename(cwd), 'agent')`, `machine` to `sanitize(hostname.split('.')[0], 'host')`. Token is `.trim()`ed. Throws `Error` whose message contains `AGENTLINK_TOKEN` when token is empty and `requireToken`.
  - `initConfig({ home = os.homedir(), hub } = {}) -> { path: string, token: string, created: boolean }` — creates dir and file (mode `0o600`) with `{ hub: hub ?? 'ws://127.0.0.1:7777', token: randomBytes(24).toString('base64url') }`; if the file exists, returns its token with `created: false` and does not touch it (but updates `hub` if `hub` was passed).

- [ ] **Step 1:** `git init`; write `package.json` (`"type": "module"`, `"name": "agentlink"`, `"bin": { "agentlink": "cli.mjs" }`, `"scripts": { "test": "node --test test/" }`, `"engines": { "node": ">=20" }`), `.gitignore` (`node_modules/`). Run `npm install --save-exact @modelcontextprotocol/sdk@1.32.2 ws@8.23.0`. Expected: `package-lock.json` created, no errors.
- [ ] **Step 2: Write failing tests** in `test/config.test.mjs` (each uses a fresh `mkdtemp` home):
  - `defaults name to folder and machine to short hostname`: `loadConfig({ env:{AGENTLINK_TOKEN:'t'}, home, cwd:'/x/My App!', hostname:'Aryans-MBP.local' })` → `name === 'my-app'`, `machine === 'aryans-mbp'`, `hub === 'ws://127.0.0.1:7777'`, `port === 7777`.
  - `env overrides file`: file `{hub:'ws://10.0.0.5:7777', token:'filetok'}`, env `{AGENTLINK_HUB:'ws://h:1', AGENTLINK_NAME:'API'}` → `hub === 'ws://h:1'`, `token === 'filetok'`, `name === 'api'`.
  - `trims pasted token`: file token `'  abc\n'` → `token === 'abc'`. *(Review Focus 3)*
  - `throws without token`: `assert.throws(() => loadConfig({env:{}, home}), /AGENTLINK_TOKEN/)`; with `requireToken:false` returns `token === ''`.
  - `initConfig creates once`: first call `created === true`, token length ≥ 32, file mode `& 0o777 === 0o600`; second call `created === false`, same token.
- [ ] **Step 3:** Run `npm test`. Expected: FAIL, cannot find `lib/config.mjs`.
- [ ] **Step 4:** Implement `lib/config.mjs` per Interfaces.
- [ ] **Step 5:** Run `npm test`. Expected: 5 pass.
- [ ] **Step 6:** Commit `chore: scaffold agentlink and config loader`.

---

### Task 2: Protocol and hub

**Files:**
- Create: `lib/protocol.mjs`, `hub.mjs`
- Test: `test/hub.test.mjs`, `test/helpers.mjs`

**Interfaces:**
- Consumes: `loadConfig` (only in `hub.mjs` main block, with `requireToken: true`).
- Produces:
  - `lib/protocol.mjs`: constants `PROTOCOL_VERSION = 1`, `DEFAULT_PORT = 7777`, `MAX_TEXT_BYTES = 32768`, `QUEUE_LIMIT = 100`, `CLOSE = { BAD_TOKEN:4001, NAME_TAKEN:4002, BAD_FRAME:4003, HELLO_REQUIRED:4004 }`; `agentId(name, machine) -> string`; `parseFrame(raw: string|Buffer) -> { ok: true, frame } | { ok: false, message: string }` — JSON object with string `type` in `hello|send|list|status`; `hello` needs string `token`,`name`,`machine`,`kind`; `send` needs string `id`,`to`,`text`, optional string `reply_to`; `status` needs string `summary`. Unknown fields ignored.
  - `hub.mjs`: `createHub({ token, port = 7777, host = '0.0.0.0', pingMs = 20000, helloMs = 5000 }) -> Promise<{ port: number, close(): Promise<void> }>` (`port: 0` picks a free port; returned `port` is the real one). Main block (when `process.argv[1]` resolves to this file): `loadConfig`, `createHub({ token, port })`, print `agentlink hub listening on :<port>` and each non-internal IPv4 as `ws://<ip>:<port>` to stderr.
  - `test/helpers.mjs`: `connect(port, { token, name, machine = 'test', kind = 'test', summary }) -> Promise<{ ws, welcome, next(type?) -> Promise<frame>, sendFrame(obj), closed: Promise<{code}> }>` — buffers incoming frames so `next` never misses one.

Hub behaviour (decided here, not in spec): roster entry `{ id, name, kind, summary, online, since }` where `since` is ISO time of the last online/offline change; roster replies sorted by `id`; `to` resolves by exact id first, else by bare `name` among all known agents (1 → that one, >1 → `ambiguous`, 0 → `unknown_agent`); queued messages flush in order right after `welcome`; `status` updates summary with no reply; sending to yourself is allowed.

- [ ] **Step 1: Write failing tests** in `test/hub.test.mjs`, each against `createHub({ token:'secret', port:0, pingMs:200, helloMs:200 })`:
  - `rejects bad token`: hello with `token:'nope'` → receives `{type:'error', code:'bad_token'}` and `closed.code === 4001`.
  - `rejects frames before hello`: first frame `{type:'list'}` → `code:'hello_required'`, close `4004`; silent socket closes with `4004` after `helloMs`.
  - `welcome gives agent id`: hello `name:'api', machine:'pc-b'` → `welcome.agent_id === 'api@pc-b'`.
  - `rejects duplicate online id`: second hello as `api@pc-b` → `code:'name_taken'`, close `4002`; first connection still open.
  - `delivers by bare name and acks`: A sends `{type:'send', id:'m1', to:'api', text:'hi', reply_to:'m0'}` → A gets `{type:'ack', id:'m1', result:'delivered'}`; B gets `message` with `id:'m1'`, `from:'front@test'`, `to:'api@pc-b'`, `text:'hi'`, `reply_to:'m0'`, `sent_at` parseable by `Date.parse`.
  - `unknown and ambiguous`: `to:'ghost'` → `unknown_agent`; with `api@pc-a` and `api@pc-b` both known, `to:'api'` → `ambiguous`, `to:'api@pc-a'` → `delivered`.
  - `queues for offline agent and flushes in order`: B connects, disconnects; A sends `q1`,`q2` → both ack `queued`; B reconnects → `welcome` then `message q1` then `message q2`.
  - `queue drops oldest past 100`: 101 queued sends → on reconnect first delivered id is the 2nd sent, 100 messages total.
  - `roster shows online state and summary`: hello with `summary:'auth work'`, then `{type:'status', summary:'tests'}`; another agent's `list` → `roster.agents` sorted, entry `{id:'api@pc-b', kind:'test', summary:'tests', online:true}`; after B closes, `online:false`.
  - `text round-trips and cap counts bytes`: `'line1\nline2 🚀 ünïcode'` arrives identical. A 16 400-char string of `'é'` (32 800 bytes) → ack `too_large`, nothing delivered; exactly 32 768 bytes of `'a'` → `delivered`. *(Review Focus 4)*
  - `malformed frame closes`: after hello, send `'not json'` → `code:'bad_frame'`, close `4003`.
  - `dead peer marked offline`: client that stops answering pings (`ws._socket.pause()`) shows `online:false` in roster within `3 × pingMs`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL, cannot find `hub.mjs`.
- [ ] **Step 3:** Implement `lib/protocol.mjs`, `test/helpers.mjs`, then `hub.mjs` with `ws`'s `WebSocketServer`. Ping: mark `alive=false` each interval, `ws.ping()`, set `alive=true` on `pong`, `terminate()` if still false next tick.
- [ ] **Step 4:** Run `npm test`. Expected: all hub and config tests pass.
- [ ] **Step 5:** Commit `feat: hub with routing, roster and offline queue`.

---

### Task 3: Reconnecting hub client

**Files:**
- Create: `lib/hub-client.mjs`
- Test: `test/hub-client.test.mjs`

**Interfaces:**
- Consumes: `createHub` (tests), `parseFrame`-compatible frames, `agentId`, `PROTOCOL_VERSION`.
- Produces: `class HubClient extends EventEmitter`:
  - `constructor({ url, token, name, machine, kind = 'claude-code', summary = '', minBackoffMs = 1000, maxBackoffMs = 30000, timeoutMs = 5000 })`
  - `start(): void` — connect; on close, reconnect with doubling backoff capped at max, reset after a `welcome`.
  - `stop(): Promise<void>` — no further reconnects; resolves when closed.
  - `get connected(): boolean`, `get agentId(): string | null`, `get url(): string`
  - `send({ to, text, reply_to }): Promise<'delivered'|'queued'|'unknown_agent'|'ambiguous'|'too_large'>` — generates `id` with `crypto.randomUUID()`, resolves on matching `ack`; rejects `Error('hub unreachable at <url>')` immediately when not connected, `Error('hub did not answer within 5s')` on timeout.
  - `list(): Promise<Array<{ id, name, kind, summary, online, since }>>` — FIFO-matched to `roster` replies; same reject rules.
  - `setStatus(summary: string): void` — stores it (sent in every later `hello`) and sends `status` if connected.
  - Events: `'welcome'(agentId)`, `'message'(frame)`, `'disconnected'()`, `'fatal'(Error)` (on `bad_token`: stop reconnecting).
  - On `name_taken`: retry immediately with name `<base>-2`, then `-3`, … (base is the configured name).

- [ ] **Step 1: Write failing tests** in `test/hub-client.test.mjs` (hub on `port:0`, client `minBackoffMs:50, maxBackoffMs:200, timeoutMs:300`):
  - `connects, sends and receives`: two clients; `await a.send({to:'b', text:'x'}) === 'delivered'`; b emits `message` with `text:'x'`, `from:a.agentId`.
  - `list returns roster`: `(await a.list()).map(r=>r.id)` includes both ids.
  - `unreachable hub fails fast with url`: client on a closed port; `await assert.rejects(c.send({to:'b',text:'x'}), /hub unreachable at ws:\/\/127\.0\.0\.1:\d+/)` within 100 ms. *(Review Focus 1)*
  - `reconnects after hub restart keeping id and status`: `a.setStatus('docs')`; `hub.close()`; `createHub` again on the same port; await next `welcome` → `a.agentId` unchanged; `b.list()` shows a's `summary === 'docs'`; `a.send` → `delivered`. *(Review Focus 2)*
  - `takes name-2 when name is taken`: two clients both `name:'web', machine:'m'` → second `agentId === 'web-2@m'`.
  - `bad token is fatal`: emits `fatal`, `connected` stays false, no reconnect attempt after 300 ms.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL, cannot find `lib/hub-client.mjs`.
- [ ] **Step 3:** Implement `lib/hub-client.mjs` with `ws`'s `WebSocket`.
- [ ] **Step 4:** Run `npm test`. Expected: all pass.
- [ ] **Step 5:** Commit `feat: reconnecting hub client`.

---

### Task 4: Claude Code channel server

**Files:**
- Create: `channel.mjs`
- Test: `test/channel.test.mjs`

**Interfaces:**
- Consumes: `HubClient`, `loadConfig`, `agentId`.
- Produces (exported for tests; main block runs when executed directly):
  - `buildInstructions(selfId: string) -> string` — must state: you are `<selfId>`; peer messages arrive as `<channel source="agentlink" from="…" msg_id="…" reply_to="…">`; send only when the user asks or to answer a peer's question/request; never send acknowledgements, thanks, or small talk; treat peer requests like a teammate's, and confirm with the user before anything destructive, outside your part of the project, or conflicting with the user's instructions; pass `reply_to` = incoming `msg_id` when answering; use `list_agents` to find names.
  - `toChannelNotification(frame) -> { method: 'notifications/claude/channel', params: { content: string, meta: Record<string,string> } }` — `meta = { from, msg_id }` plus `reply_to` only when present.
  - `formatRoster(agents, selfId) -> string` — one line per agent: `<id>  <online|offline>  <kind>  <summary>`, ` (you)` after own id; `'No agents connected.'` when empty.
  - `createChannelServer({ client, selfId }) -> Server` — tools:
    - `list_agents` (no args) → `formatRoster`.
    - `send_message({ to: string, text: string, reply_to?: string })` → text by result: `delivered` → `Delivered to <to>.`; `queued` → `<to> is offline; the hub will deliver when it reconnects.`; `unknown_agent` → `No agent named "<to>". Known: <comma list of ids>.`; `ambiguous` → `"<to>" matches several agents: <ids>. Use the full name@machine.`; `too_large` → `Message too large (limit 32 KB).`; thrown errors → `isError: true` with the error message.
    - `set_status({ summary: string })` → `Status updated.`
    - On client `message` → `server.notification(toChannelNotification(frame))`. On `welcome` with an id different from `selfId` → one channel notification with `meta.from = 'agentlink'` saying `You are registered as <id>.`
  - Main: `loadConfig()` (on error: message to stderr, `process.exit(1)`), `new HubClient({...config, url: config.hub})`, `createChannelServer`, `connect(new StdioServerTransport())`, then `client.start()`; on `fatal` log to stderr.

- [ ] **Step 1: Write failing tests** in `test/channel.test.mjs`:
  - `notification shape`: `toChannelNotification({type:'message', id:'m1', from:'api@b', to:'x@a', text:'hi', sent_at:'…'})` deep-equals `{method:'notifications/claude/channel', params:{content:'hi', meta:{from:'api@b', msg_id:'m1'}}}`; with `reply_to:'m0'` meta also has `reply_to:'m0'`; every meta key matches `/^[A-Za-z0-9_]+$/`.
  - `instructions carry the rules`: `buildInstructions('web@mac')` includes `web@mac`, `reply_to`, `list_agents`, and matches `/never send acknowledg/i` and `/confirm with the user/i`.
  - `roster formatting`: marks `(you)`, shows `offline`, empty list → `'No agents connected.'`.
  - `end-to-end over stdio`: start `createHub` on `port:0`; spawn `node channel.mjs` via the SDK's `StdioClientTransport` with env `AGENTLINK_TOKEN`, `AGENTLINK_HUB`, `AGENTLINK_NAME=web`, `AGENTLINK_HOST=mac`, `HOME=<tmpdir>`; `Client` declares nothing special; after `initialize`, server capabilities include `experimental['claude/channel']`; `listTools` names are exactly `list_agents, send_message, set_status`; a test `HubClient` named `api` sends `{to:'web', text:'ping'}` → the MCP client receives a `notifications/claude/channel` notification (register with `client.fallbackNotificationHandler`) with `content:'ping'`, `meta.from:'api@test'`; `callTool('send_message', {to:'api', text:'pong'})` → text `Delivered to api.` and the test client receives `pong`. *(Review Focus 5: any stray stdout breaks this test.)*
- [ ] **Step 2:** Run `npm test`. Expected: FAIL, cannot find `channel.mjs`.
- [ ] **Step 3:** Implement `channel.mjs` with `Server`, `ListToolsRequestSchema`, `CallToolRequestSchema` from `@modelcontextprotocol/sdk` 1.32.2. Replace any `console.log` with `console.error`.
- [ ] **Step 4:** Run `npm test`. Expected: all pass. Also `grep -n "console.log" channel.mjs lib/` prints nothing.
- [ ] **Step 5:** Commit `feat: Claude Code channel server for agentlink`.

---

### Task 5: CLI and docs

**Files:**
- Create: `cli.mjs`, `README.md`, `PROTOCOL.md`, `examples/mcp.json`
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: `initConfig`, `loadConfig`, `createHub`, `HubClient` (with `kind: 'cli'`, name default `cli` unless `AGENTLINK_NAME`).
- Produces commands (`#!/usr/bin/env node`, `chmod +x`):
  - `agentlink init [--hub ws://IP:7777]` → prints config path, token, and `Copy this token into ~/.agentlink/config.json on the other PC.` (prints `already exists` variant when `created:false`).
  - `agentlink hub` → runs the hub as `hub.mjs` main does.
  - `agentlink list` → `formatRoster`, exit 0.
  - `agentlink send <to> <text...>` → prints the same result text as the `send_message` tool, exit 0 on `delivered|queued`, 1 otherwise.
  - `agentlink listen` → prints each message as `[<from>] <text>` until Ctrl‑C.
  - Errors (hub unreachable, bad token) → message to stderr, exit 1, within 6 s.

- [ ] **Step 1: Write failing test** `test/cli.test.mjs` → `send and list via CLI`: hub on `port:0`, a `HubClient` named `web`; `execFile('node', ['cli.mjs','send','web','hello from cli'], {env:{...AGENTLINK_TOKEN, AGENTLINK_HUB, HOME:tmp}})` → stdout includes `Delivered to web.`, exit 0, `web` receives `hello from cli`; `cli.mjs list` stdout includes `web@`; `send` against a dead port exits 1 with stderr matching `/hub unreachable/`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement `cli.mjs` (move `formatRoster` and the result-text mapping into `lib/format.mjs` if both `channel.mjs` and `cli.mjs` need them, and update Task 4's imports).
- [ ] **Step 4:** Run `npm test`. Expected: all pass.
- [ ] **Step 5:** Write docs:
  - `examples/mcp.json`: `{"mcpServers":{"agentlink":{"command":"node","args":["/ABSOLUTE/PATH/agentlink/channel.mjs"]}}}`.
  - `README.md` sections: What it is · Requirements (Node ≥ 20, Claude Code CLI, Pro/Max/Ultra or channels enabled by the Team/Enterprise owner) · One-time setup on the hub PC (`npm install`, `agentlink init --hub ws://<LAN IP>:7777`, `agentlink hub`, allow port 7777 through macOS/Windows firewall) · Setup on the other PC (copy folder or `git clone`, `npm install`, write `~/.agentlink/config.json` with the hub URL and the same token) · Registering the MCP server (`claude mcp add --scope user agentlink -- node /ABS/channel.mjs` or per-project `.mcp.json`) · Starting a session (`AGENTLINK_NAME=frontend claude --dangerously-load-development-channels server:agentlink`, PowerShell: `$env:AGENTLINK_NAME="frontend"; claude --dangerously-load-development-channels server:agentlink`; choose "I am using this for local development") · Using it (ask Claude "list agents", "tell api …") · Optional: allow `mcp__agentlink__send_message` and `mcp__agentlink__list_agents` in `.claude/settings.json` to skip prompts · Troubleshooting (`/mcp` shows failed → missing token; `hub unreachable` → IP/firewall/hub not running; messages not arriving → session not started with the flag, or `MCP_SDK_GENERATION`/v2 runtime: set `MCP_PROTOCOL_NEGOTIATION=legacy`) · Security note (token keeps strangers out; traffic is not encrypted).
  - `PROTOCOL.md`: transport, hello/welcome, every frame from the spec with one JSON example each, ack results incl. `too_large`, close codes, name resolution rules, queue limits, `v:1`.
- [ ] **Step 6:** Commit `feat: agentlink CLI and setup docs`.

---

### Task 6: Live check with real Claude Code sessions

**Files:** none (fix-ups only if something fails).

- [ ] **Step 1:** `npm test` → all pass.
- [ ] **Step 2:** On this Mac: `node cli.mjs init`, `node cli.mjs hub` (background), register the MCP server per README, and start two terminal sessions in two folders: `AGENTLINK_NAME=alpha claude --dangerously-load-development-channels server:agentlink` and the same with `beta`. Expected: startup notice `Channels (experimental) messages from server:agentlink inject directly in this session`.
- [ ] **Step 3:** In `alpha`, ask "list agents" → shows `alpha@…` (you) and `beta@…`. Ask "ask beta what folder it's in" → `beta` shows `← agentlink: …` and answers with `reply_to`; `alpha` receives the answer. Neither sends a follow-up acknowledgement.
- [ ] **Step 4:** `node cli.mjs send beta "hello from the CLI"` → `beta` receives it.
- [ ] **Step 5:** Stop the hub, restart it; within 30 s `alpha` can send again.
- [ ] **Step 6:** Second PC: the user follows README; one message each way. Record any README fixes and commit `docs: fixes from live test`.
