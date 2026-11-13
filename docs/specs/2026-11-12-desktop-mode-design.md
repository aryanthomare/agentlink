# agentlink desktop mode: design

## Why

The user runs Claude Code in the Claude desktop app's Code tab on each PC. Each PC is signed into a
different Claude account, so the app's built-in session messaging can't reach across, because it
only covers one account. agentlink tools already load in desktop sessions (user-scope MCP), but
pushed channel messages don't, because the desktop app can't pass
`--dangerously-load-development-channels`. The channel also confirms each message to the hub as
`received`, so a desktop session silently loses every message it gets.

## Goal

A desktop session wakes up and handles a message from another agent when the message arrives,
without the user typing anything, and without losing messages. Terminal sessions keep working as
they do today.

Non-goals: the app's internal messaging socket (undocumented, could break on any update, and
writes straight into a session's context); changes to the hub or wire protocol.
Anti-goals: waking idle sessions when no message has arrived (a cost with nothing to show for it);
dropping messages.

## Approaches

1. **Background `agentlink wait` (chosen).** The channel keeps incoming messages in a local inbox.
   Claude runs `agentlink wait` as a background Bash command. It blocks until messages arrive,
   prints them and exits. The exit wakes the session; Claude handles the messages and starts
   `wait` again. Waiting costs nothing.
2. A Monitor streaming `agentlink listen`. Rejected: a monitor expires after 30 minutes at most,
   so each idle session is woken about 48 times a day just to restart it.
3. Inject pending messages with a UserPromptSubmit hook. Rejected: it doesn't wake an idle
   session, which is the whole point.

## Design

- **Mode.** The channel uses inbox mode when `CLAUDE_CODE_ENTRYPOINT=claude-desktop` (set by the
  desktop app) or `AGENTLINK_MODE=inbox`. `AGENTLINK_MODE=channel` forces today's behaviour.
- **Inbox.** A local socket owned by the channel process: `~/.agentlink/run/<pid>.sock` on
  macOS/Linux and `\\.\pipe\agentlink-<pid>` on Windows. Messages wait in memory. A `wait` client
  connects and gets every pending message once at least one exists, as JSON lines. It sends back
  `ok` after printing, and only then does the channel confirm them to the hub (`received`). If
  `wait` dies first, the messages stay pending. A new waiter replaces an older one.
- **Hub client.** A new `confirm: 'manual'` option plus `confirm(id)`, so the channel decides when
  a message counts as received. A re-sent duplicate of an already-confirmed id is confirmed again,
  so a confirmation lost in a disconnect doesn't leave the message in flight forever.
- **`agentlink wait <inbox>`.** Prints each message as a header line (`from`, `msg_id`,
  `reply_to`) and its text, then a reminder line to handle them and run `wait` again. It exits 0
  after printing and 1 with a clear error if the inbox is gone (session ended).
- **Instructions.** In inbox mode the instructions give Claude the exact command (absolute paths)
  and tell it to start the command in the background at the start of the session and after every
  batch. The same rules as today apply (no acknowledgements and so on). Notices (renamed, bad
  token) go into the inbox too.
- **Naming.** Desktop sessions can't take an env var per session, so the default name stays the
  folder name. A new `set_name` tool renames the session on the hub (it reconnects under the new
  name).

## Left to the builder

The exact wording of the instructions and the output format of `wait`. Inbox tests run on the
local OS only.
