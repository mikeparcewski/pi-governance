# pi-governance

A [pi](https://github.com/possibilities/pi) extension that gives pi the approval prompt it lacks.
pi 1.1.0 "does not ask for approval before every tool call"; this extension makes it ask, every
time, so a host that drives pi's terminal can answer.

## Status

`0.2.0`, for pi 1.1.0 interactive seats. It replaces the 0.1.x ACP design (pi-acp), which is no
longer supported; the 0.1.0 capture evidence under `evidence/` is historical and untouched.

## How it works

pi awaits its `tool_call` hook before a tool runs, and `{ block: true, reason }` stops it. A handler
that throws also blocks.

- **Every tool asks**, `read` included, through `ctx.ui.confirm`. The dialog text is one compact JSON
  line: `{"v":2,"tool":"<canonical name>","input":{...}}`. Strings over 256 UTF-8 bytes are replaced by
  `{"bytes":N,"sha256":"..."}`. An envelope that would not fit a 250x80 pane's dialog (measured in
  terminal cells, not characters) is blocked unasked with `action too large to review`.
- **Only a yes runs the call.** On no, a one-line input asks for a reason, and its text is returned
  unchanged as the block reason. Cancel, a 600 s timeout and a thrown dialog block with fixed reasons.
- **No UI** (`-p`, `--mode json`): every call is blocked with `tools are off in headless mode`.
- **Guard shell.** When `WICKED_SEAT_SHELL` is set, pi's bash tool is replaced by one built on
  `createLocalBashOperations({ shellPath })`. The user's `shellPath` setting is not read or written. If
  the replacement cannot be installed, bash is blocked.
- **Gate socket.** On `session_start` and `agent_end` a JSON line goes to `WICKED_SEAT_GATE_SOCKET`:
  `{"ext":"pi-governance","version":"0.2.0"}` and `{"ext":"pi-governance","event":"turn-end"}`.
  Observability only.

Known limitation: pi's `confirm` returns a boolean, so Escape at the first dialog is reported as
`false` (a no) when pi does so; the extension then opens the reason input, where Escape or an empty
submit blocks with the cancel/denied reason. A non-boolean answer is treated as a cancel.

## Install

- For one run: `pi -e /path/to/pi-governance/extensions/pi-governance.js`
- As a package: `pi install git:github.com/mikeparcewski/pi-governance@v0.2.0`
- Load only this extension: `pi -ne -e <path>`. Another
  extension's `tool_call` handler could change a call's arguments after this one approved it, so
  a governed seat should not load other extensions.

The extension runs inside pi with pi's own permissions. It is the permission transport, not a
sandbox, so keep an OS boundary around the seat as well.

## Tests

`npm test` runs lint, the unit tests and the live suite. The live suite (`npm run test:live`) drives
pi 1.1.0 in a 250x80 tmux pane against a stub model on loopback. Without pi or tmux and with `CI`
unset it prints a counted `SKIPPED n/5` line per case; with `CI` set it fails. The old ACP harness
is in `test/live/legacy/` and is not run.

## Design notes

- **Defence in depth, not either/or.** pi also offers `--tools`, `--exclude-tools` and
  `--no-builtin-tools`. For a read-only context, withholding the write tools is a stronger
  guarantee than a prompt that must be both asked *and* honoured. This extension does not replace
  that; the two compose.
- **Why an extension.** pi has a first-class extension system (`pi install`, `-e <path>`,
  discovery under `~/.pi/agent/extensions`, extension-registered flags). That makes it possible for
  the permission boundary to be *inside* the tool pipeline, which is the only place it can be
  authoritative.

## License

MIT
