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

Early, and captured. `pi-governance` 0.1.0 meets the admission bar below against
**pi 0.84.2** — see [`evidence/2026-09-22/CAPTURE.md`](evidence/2026-09-22/CAPTURE.md) for
the run, the raw wire, and what it does *not* establish.

## Use

```
npm ci && npm run build
```

Point an ACP host at the binary. It speaks ACP on stdio and runs the real `pi` CLI
underneath, one process per session:

```
pi-governance [--pi <path to pi>] [-- <extra pi args>]
```

Everything after `--` is handed to pi verbatim, so the flags you already use still apply:

```
pi-governance -- --provider anthropic --model claude-sonnet-4-5 --exclude-tools write,edit
```

## How it works

pi's extension system exposes a `tool_call` hook that runs **before** pi prepares or
executes the tool, and that can block it. In RPC mode, a `ctx.ui.select()` inside that hook
becomes an `extension_ui_request` on pi's stdout which blocks until the embedding process
answers on stdin — the one blocking round-trip an extension has with its host. That is the
seam this adapter is built on:

```
host ──ACP──▶ pi-governance ──pi --mode rpc──▶ pi
                    │                            │  tool_call hook (blocks)
                    │◀── extension_ui_request ───┘
    ◀ session/request_permission ─┤
    ── selected: allow-once ─────▶│
                    └── extension_ui_response ──▶ pi executes (or does not)
```

Two consequences worth stating plainly:

- pi emits `tool_execution_start` *before* it runs the hook, so the adapter maps that to
  ACP `pending`, not `in_progress`. A tool call that reaches `in_progress` in a capture has
  already been answered on the wire.
- Only `allow-once` / `reject-once` are offered. An "always" answer would let a later tool
  call run with no round-trip, and a boundary that is sometimes silent cannot be audited.

Anything that is not an explicit allow blocks the call: a cancelled dialog, an unknown
option id, a failed request, or a pi started with no host channel at all.

## Admission

An adapter is not trusted because it claims to ask. It is trusted when a capture shows it asking.
The bar, deliberately the same one that disqualified the adapter this replaces:

1. Every tool kind — `read`, `edit`, `write`, `bash` — issues `session/request_permission` before
   execution.
2. A `write` **must not** reach `in_progress` without a permission response.
3. A denial is visible on the wire and the write does not happen.
4. The capture is stored as evidence and cites the exact pi and extension versions it was taken
   against.

A new pi or extension version re-runs the capture. A version that has not been captured is not
admitted, however small the change.

### The capture

```
node capture/capture.mjs       # three scenarios: allow, deny-the-write, and the negative control
node capture/real-model.mjs    # corroboration with a real model (needs a local Ollama server)
```

`capture/capture.mjs` runs the real adapter against the real `pi` binary over a real ACP
stdio connection, records every JSON-RPC line in both directions, then judges the recording.
Disk state is read back from the file system; a "denied" message on the wire is never
accepted as evidence that bytes were not written.

It is built to fail loudly, because an empty capture reads exactly like a passing one. A
recording that is empty or short, a child that dies, a turn that never completes, a scenario
count or assertion count that does not match the expected one, and a run that ends without
reaching a verdict all exit non-zero and say which. The harness has been mutation-tested —
an extension that reports a denial without enforcing it, an extension that never asks, and
an adapter that exits immediately are all caught, with the output recorded in
[`evidence/2026-09-22/CAPTURE.md`](evidence/2026-09-22/CAPTURE.md).

The third scenario is the negative control: the same capture with the governance extension
**not** loaded (`--negative-control`). It shows a `write` going `pending → in_progress →
completed` with **zero** permission round-trips and `CANARY-WRITE` on disk afterwards —
the behaviour described under "Why this exists", reproduced here so the guard has been seen
failing rather than only passing.

The model in those three scenarios is scripted (`capture/scripted-provider.ts`) so that all
four tool kinds appear in a fixed order on every run; pi, its tools, the extension hook and
the ACP wire are all real. `capture/real-model.mjs` covers the other side with a real model
choosing its own tool call. There is no capture against a hosted frontier model yet.

## Design notes

- **Defence in depth, not either/or.** pi also offers `--tools`, `--exclude-tools` and
  `--no-builtin-tools`. For a read-only context, withholding the write tools is a stronger
  guarantee than a prompt that must be both asked *and* honoured. This extension does not replace
  that; the two compose.
- **Why an extension.** pi has a first-class extension system (`pi install`, `-e <path>`,
  discovery under `~/.pi/agent/extensions`, extension-registered flags). That makes it possible for
  the permission boundary to be *inside* the tool pipeline, which is the only place it can be
  authoritative.
- **Other extensions' dialogs are dismissed.** ACP has no surface for arbitrary agent-side UI,
  so a `select`/`confirm`/`input`/`editor` that is not a permission request is cancelled and
  logged to stderr rather than answered on the host's behalf. Fire-and-forget methods
  (`notify`, `setStatus`, ...) are ignored.
- **`--negative-control` is not a mode.** It starts pi without the extension so the capture
  can show what no boundary looks like. It prints a banner saying so and exists for the
  capture only.

Layout: `src/extension.ts` is the hook, `src/protocol.ts` is the envelope both sides share,
`src/acp-agent.ts` maps pi's RPC events onto ACP, `src/cli.ts` is the binary, and everything
under `capture/` produces `evidence/`.

## License

MIT
