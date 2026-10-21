# Changelog

## 0.2.0

- Rebuilt for pi 1.1.0 interactive seats (no ACP): every tool call, `read` included, goes through
  `ctx.ui.confirm` with a one-line `{"v":2,"tool","input"}` envelope; strings over 256 bytes become
  `{bytes, sha256}`, and an envelope too big for a 250x80 pane's dialog is blocked ("action too large
  to review").
- On no, a one-line reason input; its text is returned unchanged as the block reason. Cancel, timeout
  (600 s) and a thrown dialog block with fixed reasons. With no UI (`-p`, `--mode json`) every call is
  blocked with "tools are off in headless mode".
- `WICKED_SEAT_SHELL` replaces pi's bash tool with one on `createLocalBashOperations({ shellPath })`;
  the user's `shellPath` setting is untouched. If that cannot be set up, bash is blocked.
- Load and turn-end records go to `WICKED_SEAT_GATE_SOCKET`.
- Tests: unit tests plus five tmux tests against pi 1.1.0 and a stub model; they skip with a counted
  line when pi or tmux is missing and `CI` is unset. The pi-acp harness moved to `test/live/legacy/`.
- Breaking: the envelope is v2 (`v`, `tool`, `input`); v1 (`pi-governance`, `toolCallId`, `toolName`) is gone.
