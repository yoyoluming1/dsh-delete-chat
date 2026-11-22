# Changelog

## 0.1.1

- Create the derived conversation through the agent factory and attach it to the
  source workspace, so it appears in the sidebar immediately, carries its
  projection cache (title, status) and gets an idle Agent for the next prompt.
- Number the derived conversation's title (`Title (1)`), matching the built-in
  branch convention, so the untouched source cannot be mistaken for the deletion
  coming back.
- Archive the source conversation automatically after a successful delete; it
  stays recoverable through *unarchive*.
- Refresh the client session list before opening the new conversation.

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
