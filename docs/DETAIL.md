# Delete chat segment

Delete one turn of a DeepSeek Harness conversation. The deleted turn is left out
of a **new** Session that keeps the surrounding conversation:

- **Delete this turn only** keeps the turns before and after it.
- **Delete this turn and everything after** keeps only the earlier turns.

The original conversation is never modified: DSH Session logs are append-only, so
the plugin derives a new Session from a rebuilt event log, writes it through the
persistence backend, and reopens it once to prove the stored log is readable.

## Where it appears

A **删除对话 / Delete** control is added under every completed turn in the Chat.
Clicking it opens a small panel with the two modes and a Cancel button. The new
conversation opens automatically after the Host finishes building it.

## Requirements

- Web or Desktop DSH with the Chat surface enabled (the control lives in the
  `conversation.chat.turnTail` slot).
- A completed turn; a running conversation is refused until the current turn ends.

## Limitations

- Whole turns only, not single messages or tool calls.
- Sessions created by a fork are refused by both modes; the inherited-cut marker
  cannot survive a rebuild.
- Deleting a middle turn can be refused when a later system-prompt replacement or
  a compaction transaction still references it. Truncating from that turn is
  always available as a fallback.
- The new conversation has a new Session id. Archive the old one from the
  conversation list if you no longer need it.
- Later turn numbers shift down after a middle deletion.
