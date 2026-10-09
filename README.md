# pi-governance

A governable ACP adapter for the [pi](https://github.com/possibilities/pi) CLI, shipped as a pi
extension.

**The name is the contract.** Every tool call pi makes — `read`, `edit`, `write`, `bash` — is
surfaced as a real ACP `session/request_permission` round-trip **before** it executes. This is not
a wrapper, a re-skin, or a transport that happens to carry tool calls. Its job is the boundary.

## Why this exists

A host that embeds pi through ACP can only enforce a boundary it can see. The community adapter
(`pi-acp`) does not provide one: a live capture against `pi-acp@0.0.32` (gitHead `2f6e3c5`) showed
a core `write` go `pending → in_progress → completed` with **zero** permission round-trips, and the
adapter's source confirmed the same path serves `read`/`edit`/`bash`. Its `requestPermission` is
invoked only for pi's own select/confirm UI, never for tool execution.

The practical consequence: a host cannot hold a repository read-only while pi works in it, so pi
gets excluded from exactly the contexts where a second independent model is most valuable.

`pi-governance` closes that by participating in pi's own tool pipeline rather than observing a
stream after the fact.

## Status

`0.1.0`: the gate is built and captured against pi `0.84.2` with pi-acp `0.0.32` (and re-checked on
pi-acp `0.0.34`). See **Evidence** below. A host still decides for itself whether to admit it; the
wicked platform pins the captured versions in its seat registry.

## How it works

pi awaits its `tool_call` hook before any tool runs, and a `{ block: true }` result means the tool
never runs. The extension handles that hook for every tool and asks the host through
`ctx.ui.confirm`. Under `pi --mode rpc`, which is how pi-acp runs pi, that becomes an
`extension_ui_request`, and pi-acp turns it into a real ACP `session/request_permission`.

- Every tool asks. There is no list of tools that are safe by name.
- Only an explicit yes runs the call. A reject, a cancel, a thrown dialog, or a mode with no
  permission channel (`-p`, `--mode json`) is a deny.
- The request names the call so a host can judge it, not just read prose:
  - `toolCall.title` is the bare pi tool name (`read`, `bash`, `edit`, `write`, ...).
  - `toolCall.rawInput.message` is a JSON envelope:

    ```json
    {"pi-governance":1,"toolCallId":"<pi's id>","toolName":"write","input":{"path":"...","content":"..."}}
    ```

    `input` holds the tool's real arguments. `toolCallId` matches the id on pi-acp's own
    `tool_call` updates, so a host can check that no call ran without an answer.

## Install

- For one run: `pi -e /path/to/pi-governance/extensions/pi-governance.js`
- As a package: `pi install git:github.com/mikeparcewski/pi-governance@v0.1.0`
- Under an ACP host, load only this extension: `pi --no-extensions -e <path> --mode rpc`. Another
  extension's `tool_call` handler could change a call's arguments after this one approved it, so
  a governed seat should not load other extensions.

The extension runs inside pi with pi's own permissions. It is the permission transport, not a
sandbox, so keep an OS boundary around the seat as well.

## Admission

An adapter is not trusted because it claims to ask. It is trusted when a capture shows it asking.
The bar, deliberately the same one that disqualified the adapter this replaces:

1. Every tool kind — `read`, `edit`, `write`, `bash` — issues `session/request_permission` before
   execution.
2. No call reaches `completed`, and no side effect happens, before the host answers. (pi-acp
   reports `in_progress` when pi starts a tool, which is before the hook asks; see **Evidence**.)
3. A denial is visible on the wire and the write does not happen.
4. The capture is stored as evidence and cites the exact pi and extension versions it was taken
   against.

A new pi or extension version re-runs the capture. A version that has not been captured is not
admitted, however small the change.

## Evidence

`evidence/pi-0.84.2_pi-acp-0.0.32/`, taken with `test/live/capture.mjs`. An ACP client drives
pi-acp -> pi against a scripted local model (`test/live/mock-openai.mjs`), so the capture needs no
account and no network. Each directory holds `frames.jsonl` (every frame, both directions),
`model.jsonl` (what pi sent the model) and `summary.json`.

| Capture | Result |
|---|---|
| `write-nogate-deny` | Baseline without the extension. The `write` goes pending -> in_progress -> completed with zero permission requests, and the file is written. This reproduces the defect. |
| `write-gate-deny` | One `session/request_permission` for `write`. The host rejects, the call ends `failed`, and no file is written. |
| `write-gate-allow` | Same request. The host allows and the file is written. |
| `four-gate-deny` | `read`, `bash`, `edit` and `write` each ask once, in order. Every one is rejected: nothing is written, the edit doesn't land, and the bash redirect never runs. |
| `four-gate-allow` | All four ask and are allowed, and all four side effects happen. |

`evidence/pi-0.84.2_pi-acp-0.0.34/four-gate-deny` repeats the four-tool deny on the newer pi-acp.

One detail an admission check has to account for: pi-acp sends `in_progress` when pi starts a
tool (`tool_execution_start`), and that is before the `tool_call` hook runs. So `in_progress`
comes before the permission request in every gated capture. The property that matters is the
next one: no call reaches `completed`, and no side effect happens, before the host answers.
`summary.json` checks that per call.

Re-run a capture:

```
node test/live/capture.mjs --pi-acp <pi-acp>/dist/index.js --scenario four --answer deny --gate on --out evidence/<dir>
```

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
