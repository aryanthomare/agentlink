# agentlink desktop mode: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Desktop-app sessions receive agentlink messages through a local inbox and a background `agentlink wait`.
**Architecture:** Channel inbox mode (local socket) + manual confirmation in HubClient + `wait` CLI command.
**Tech Stack:** Node ≥20 ESM, `node:net`, `ws@8.23.0`, `@modelcontextprotocol/sdk@1.32.2`, `node:test`.
**Spec:** docs/specs/2026-11-12-desktop-mode-design.md

## Global Constraints
- Node ≥20, plain ESM `.mjs`, no new dependencies.
- The channel never writes to stdout except MCP protocol.
- Terminal (channel) mode behaviour unchanged; all 41 existing tests stay green.

## Review Focus
- `wait` killed after receiving but before `ok`: messages must be re-delivered to the next `wait`.
- Two waiters at once: the newer one gets messages, the older exits cleanly without losing any.
- Hub reconnect while messages are pending in the inbox: no duplicates in the inbox, no message stuck in flight.
- A stale socket file from a crashed channel: a new channel with the same path still starts.
- Message text with newlines: `wait` output keeps message boundaries clear.

---

### Task 1: HubClient manual confirm and rename
Files: `lib/hub-client.mjs`, `test/hub-client.test.mjs`
Produces: `new HubClient({ confirm: 'manual' })`, `client.confirm(id): void`, `client.rename(name): void`.
- [ ] Test `manual confirm keeps message in flight until confirm()`: b gets a message with confirm:'manual', drops its connection before confirm; after reconnect the hub re-sends it (b emits no duplicate 'message', since dedupe applies), and b's `confirm(id)` then stops re-delivery across another reconnect.
- [ ] Test `rename reconnects under new name`: `a.rename('z')` → next welcome is `z@m`; roster shows a@m offline.
- [ ] Implement; run `npm test`; commit.

### Task 2: Inbox
Files: `lib/inbox.mjs`, `test/inbox.test.mjs`
Produces: `inboxPath(id, home?)`, `createInbox({ path, onConfirm }) → Promise<{ path, push(item), close() }>`, `waitInbox(path) → Promise<item[]>` (item = message frame or `{ notice }`).
- [ ] Tests: waits until a push and returns pending in order; confirms only after waiter acks; a waiter killed before ack leaves messages for the next waiter; newer waiter replaces older (older resolves []); stale socket file is replaced; waitInbox rejects with /inbox not found/ when nothing listens.
- [ ] Implement; run tests; commit.

### Task 3: Channel inbox mode, set_name, wait command, docs
Files: `channel.mjs`, `cli.mjs`, `test/channel.test.mjs`, `test/cli.test.mjs`, `README.md`
- [ ] Test `desktop mode delivers through wait`: channel spawned with `CLAUDE_CODE_ENTRYPOINT=claude-desktop`; instructions contain the wait command and the inbox path; peer sends; `node cli.mjs wait <path>` prints `from api@test` and the text and exits 0; no channel notification was emitted.
- [ ] Test `desktop mode keeps unconfirmed messages`: message sent, channel killed without wait; new channel + wait gets it.
- [ ] Test `set_name` tool renames (roster shows new id).
- [ ] Implement `buildDesktopInstructions(selfId, command)`, mode detection, `set_name`, `wait`; README "Claude desktop app" section; run `npm test`; commit.

### Task 4: Live check
- [ ] Start a desktop session in a project folder, send it a message from `agentlink chat`, and confirm it wakes, answers, and re-arms `wait`.
