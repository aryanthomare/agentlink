# agentlink

Let Claude Code sessions on different PCs on the same Wi‑Fi — even signed into different
Claude accounts — see each other and send messages that pop straight into the other session.

```
PC A                                   PC B
claude (frontend) ─┐                ┌─ claude (api)
claude (docs) ─────┼── agentlink hub ┼─ any other agent / script
                   └───── :7777 ─────┘
```

- One PC runs the **hub** (a tiny WebSocket server).
- Each Claude Code session runs the **agentlink channel** (an MCP server Claude Code starts for you).
  It gives Claude three tools — `list_agents`, `send_message`, `set_status` — and pushes incoming
  messages into the session as they arrive.
- Agents are named `name@machine`, e.g. `frontend@macbook`. You can address them by bare name when it's unique.
- Messages to an agent that's offline are held by the hub (up to 100, until the hub restarts).

## Requirements

- **Node.js 20+** on both PCs (`node --version`).
- **Claude Code CLI** in a terminal (`claude --version`). Custom channels don't load inside the
  Claude desktop app — sessions must be started from a terminal.
- Claude **Pro / Max / Ultra** accounts work as is. On a **Team / Enterprise** account an Owner must
  enable channels (claude.ai → Organization settings → Claude Code → Channels).

## 1. Set up the hub PC

```bash
cd agentlink
npm install
npm link            # optional: puts an `agentlink` command on your PATH (else use `node cli.mjs`)
agentlink init --hub <THIS PC's LAN IP>
agentlink hub
```

`agentlink hub` prints the addresses it can be reached at (`reachable at ws://192.168.x.x:7777`).
Leave it running. `init` prints a **token** and the exact command to run on the other PC.
(The hub address can be written as `192.168.1.20`, `192.168.1.20:7777` or `ws://192.168.1.20:7777`.)

Firewall: the first time the hub starts, allow Node to accept incoming connections
(macOS: *Allow*; Windows: tick *Private networks* and *Allow access*). On Windows make sure the
Wi‑Fi network is set to **Private**, not Public.

## 2. Set up the other PC

Copy this folder over (or `git clone` it), then:

```bash
cd agentlink
npm install
npm link            # optional
agentlink init --hub <HUB PC's LAN IP> --token <TOKEN FROM THE HUB PC>
```

This writes `~/.agentlink/config.json` (Windows: `%USERPROFILE%\.agentlink\config.json`). Check it works:

```bash
agentlink list
```

## 3. Register the channel with Claude Code (both PCs)

Once per PC, using the absolute path to `channel.mjs`:

```bash
claude mcp add --scope user agentlink -- node /ABSOLUTE/PATH/agentlink/channel.mjs
```

(Or put [examples/mcp.json](examples/mcp.json) into a project's `.mcp.json` with the path filled in.)

## 4. Start sessions

Give each session a name for the part of the project it works on. macOS / Linux:

```bash
AGENTLINK_NAME=frontend claude --dangerously-load-development-channels server:agentlink
```

Windows PowerShell:

```powershell
$env:AGENTLINK_NAME="frontend"; claude --dangerously-load-development-channels server:agentlink
```

Claude Code shows a warning about development channels: choose **I am using this for local
development**. Below the banner you should see
`Channels (experimental) messages from server:agentlink inject directly in this session`.

Without `AGENTLINK_NAME` the session is named after its folder.

## 5. Use it

Talk to Claude normally:

- "list agents"
- "ask api what the login endpoint returns"
- "tell frontend the auth API is done and the token is in the `Authorization` header"
- "set your status to: refactoring the database layer"

Incoming messages show in the terminal as `← agentlink: …`. Claude only sends messages when you ask,
or to answer a question another agent sent — it won't send "thanks"/"got it" replies, so agents
don't loop. It checks with you before doing anything destructive or outside its area just because
another agent asked.

You can also join from a terminal yourself:

```bash
agentlink chat        # prints incoming messages; type "@api hello" to send
agentlink send api "one-off message"
```

Use `chat` when you expect an answer — replies go back to the terminal that sent the message.
A one-off `send` registers as `cli` (or `cli-2` if `chat` is already running), so its replies wait in
the hub for that name.

### Skip the permission prompt (optional)

Claude asks before each `send_message`. To allow agentlink tools without asking, add to the
project's `.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__agentlink__send_message", "mcp__agentlink__list_agents", "mcp__agentlink__set_status"] } }
```

## Configuration

Environment variables override `~/.agentlink/config.json`:

| Variable | Meaning | Default |
|---|---|---|
| `AGENTLINK_HUB` | hub URL | `ws://127.0.0.1:7777` |
| `AGENTLINK_TOKEN` | shared secret | — (required) |
| `AGENTLINK_PORT` | port the hub listens on | `7777` |
| `AGENTLINK_NAME` | this agent's name | folder name |
| `AGENTLINK_HOST` | machine part of the id | short hostname |

## Troubleshooting

- **`/mcp` shows agentlink as failed** — usually no token (`agentlink init`), or an unreadable `~/.agentlink/config.json`. Run `node /ABSOLUTE/PATH/agentlink/channel.mjs` in a terminal to see the error.
- **"hub unreachable at ws://…"** — the hub isn't running, the IP is wrong (`agentlink hub` prints the right one), or the hub PC's firewall is blocking port 7777. Test from the other PC with `agentlink list`.
- **"hub rejected the token"** — the tokens on the two PCs differ.
- **Tools work but messages never appear in the session** — the session wasn't started with
  `--dangerously-load-development-channels server:agentlink`, or (Team/Enterprise) channels are
  disabled for your org. If you've forced Claude Code onto its v2 MCP runtime, also set
  `MCP_PROTOCOL_NEGOTIATION=legacy`.
- **Agent shows up as `name-2`** — another session is already using that name on that machine.
- **Delivery after a dropped connection** — a session confirms each message it receives. If the
  connection dies before that, the hub re-sends the message when the session reconnects. A session
  that loses Wi‑Fi notices within about 50 seconds and reconnects by itself.

## Security

The token keeps strangers on the network from talking to your agents. Traffic is **not encrypted**,
so someone on the same Wi‑Fi could read it — fine for a home network, not for public Wi‑Fi.
Anyone with the token can put text in front of your Claude sessions: share it only between your
own machines.

## Other agents

Anything that speaks WebSocket + JSON can join — see [PROTOCOL.md](PROTOCOL.md).

## Development

```bash
npm test
```
