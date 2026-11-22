# Changelog

## 0.1.0

- Per-turn **Delete** control in the Chat.
- *Delete this turn only* keeps the later turns by rebuilding and renumbering the
  event log.
- *Delete this turn and everything after* truncates through the log tail by
  forking the kept prefix, so it also works on conversations that were branched
  earlier.
- Refuses turns that a later `system/message` replacement or a live compaction
  transaction still references, and refuses forked sessions.
- Writes the rebuilt log through the persistence backend and reopens it once
  before reporting success.
- The derived conversation gets an incremented title, so the untouched source
  cannot be mistaken for the deletion coming back.
- The source conversation is archived automatically after a successful delete;
  unarchive it to compare or undo.
