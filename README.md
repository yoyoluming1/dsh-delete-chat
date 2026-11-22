# dsh-delete-chat

English | [中文](README.zh.md)

Delete part of a conversation in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

DSH Session logs are append-only: nothing can be erased in place. This plugin gives
you the two deletions that are actually possible on top of the public Session API,
and performs them by deriving a **new Session** from the part of the log you keep.
The original Session stays in your list untouched.

| Action | Result |
| --- | --- |
| **Delete this turn only** | A new Session keeps every turn before *and* after the deleted turn. |
| **Delete this turn and everything after** | A new Session keeps only the turns before the deleted turn. |

## Sent a message to the wrong conversation?

This is the case the plugin was built for. Pick the turn where the mistake
started and choose **delete this turn and everything after**: the trimmed
conversation keeps all earlier context, the stray question and everything it
caused are gone from the model history, and the original conversation is
archived instead of quietly influencing later turns. Use **delete this turn only**
when the mistake sits in the middle and the later turns are still worth keeping.

## Install

1. Clone this repository anywhere:

   ```sh
   git clone https://github.com/yoyoluming1/dsh-delete-chat.git
   ```

2. In DSH open **Plugins → Add plugin**, choose the cloned directory, then
   **Enable now**.
3. Open or create a conversation and send at least one message so a completed
   turn exists. A **删除对话 / Delete** control appears under each completed turn.

After updating the plugin source, reload the page; replacing an installed package
may require restarting DSH.

### The Delete control is missing

Client modules register at page load. Reload the page first; if the control is
still absent after enabling the plugin, restart DSH (a session keeps its log, so
nothing is lost).

## Use

Hover the last assistant reply of a turn, click **删除对话**, then pick:

- **只删除这一轮，保留后面的对话** — removes this turn and carries the later
  turns into a brand-new conversation.
- **删除这一轮及之后的所有对话** — keeps the conversation up to just before this
  turn and drops the rest.

The new conversation opens automatically and the source conversation is
archived, so the list shows one conversation instead of two look-alikes.
Unarchive the source from the archived section to compare or go back.

## How it works

The plugin registers one Host command, `delete-chat`, and a per-turn Chat control
that calls it through `ctx.remote.commands.execute`. The Host derives the kept
events and creates the new conversation through the **agent factory**
(`ctx.agents.create`) — the same transaction the built-in branch action uses:
persistence write, SessionStore entry, announcement, projection checkpoint, a
live Agent for the next prompt, and workspace attachment. Finally the source
conversation is archived.

- **Delete this turn and everything after** keeps the untouched prefix and marks
  it as an inherited fork at the cut, so turn numbers and delivery markers stay
  as written.
- **Delete this turn only** rebuilds and renumbers the kept events, remapping
  every Session-seq reference (`surfaceOp`, `sourceEventSeqs`, `headerSeq`,
  compaction ranges, title message references, image offload targets, command
  sources).

The original log is never modified, so a failed deletion cannot corrupt the
source conversation.

## Compatibility

Tested with DeepSeek Harness `0.2.2-rc.5` (Session format v4). The rebuild relies
on v4 event envelopes and the persistence backend's strict reader, so a future
DSH format change may need a plugin update.

## Limitations

- Deletion works on **whole turns**. Deletion of a single message or tool call is
  not offered.
- `keep-later` **refuses** a turn that a later `system/message` replacement or a
  live compaction transaction still references. Dropping such a reference would
  silently resurrect replaced or compacted history; use *delete this turn and
  everything after* instead.
- Sessions that are themselves forks (created by *branch into a new
  conversation*, or by a previous truncation) can still be **truncated**, but
  `keep-later` is refused on that lineage: its inherited-cut marker cannot be
  carried into a rebuilt log safely.
- The new conversation gets a new Session id and a numbered title (`Title (1)`,
  matching the built-in branch convention); the old one keeps its id, title and
  log.
- Truncation produces a forked Session: the kept prefix is marked as inherited.
  You can truncate that result again, but middle deletion stays unavailable on
  that lineage.
- After a middle deletion, later turn numbers shift down by one (turn 351 becomes
  350). This is required by the on-disk format.
- Truncation removes every record after the cut, including the latest title,
  command audit rows, background-job rows and delivered cards written after that
  turn.
- The command is refused while the conversation still has an open (running) turn.
- Titles that cite a deleted message are dropped with it.

## Publishing

`scripts/publish.sh` handles both publication paths:

```sh
# SSH: create an empty public repository on GitHub first, then
GH_OWNER=you ./scripts/publish.sh

# Token: the script also creates the repository, then pushes over HTTPS
GH_OWNER=you GH_TOKEN=... ./scripts/publish.sh
```

In token mode the token is sent through a per-command HTTP header and is never
written into `.git/config` or the repository URL.

## Development

The plugin is plain JavaScript: `index.js` (Host) and `client.js` (browser module).

```sh
node test/remap-unit.test.mjs      # turn discovery, splice handling, deletion ranges
node test/client-module.test.mjs   # client module loads and registers its slot
```

The end-to-end replay test runs against a local, decoded copy of a real session
log and is intentionally not published (it contains private conversation text).

## License

MIT
