# pi-governance

A permission boundary for the [pi](https://github.com/possibilities/pi) CLI, shipped as a pi
extension. It is 63 lines, and it is the whole product.

**The name is the contract.** Every tool call pi makes — `read`, `edit`, `write`, `bash` — is
suspended inside pi's own tool pipeline until a host answers. Carried by an ACP adapter, that
suspension surfaces as a real `session/request_permission` round-trip **before** the tool runs.

## Why this exists

pi has a blocking `tool_call` hook. pi-acp, the community ACP adapter, has the
`session/request_permission` path. What was missing between them is the thing that *asks*: an
extension that raises the gate from inside pi's pipeline. That is this repo, and nothing else.

### A correction, since this file used to say otherwise

An earlier version of this README claimed pi-acp "does not provide" a boundary, citing a capture
in which a core `write` went `pending → in_progress → completed` against `pi-acp@0.0.32` with
**zero** permission round-trips.

The observation was real. The inference was wrong. **No gate extension was loaded in that
capture**, so nothing asked and nothing was bridged — the same thing this repo's own capture
reproduces deliberately as its negative control. pi-acp has had the extension-UI → ACP permission
bridge since commit `1412ea6` ("bridge extension UI requests through ACP permissions"), which is
an ancestor of `2f6e3c5`, the exact `0.0.32` gitHead that capture ran against. It also leaves pi's
extensions enabled on purpose when it spawns pi:

```
// Keep extensions + prompt templates enabled because ACP users may rely on them
// (e.g. MCP extensions, prompt templates for workflows).
—  pi-acp 0.0.32, src/pi-rpc/process.ts:133-137
```

A live composed run then settled it end to end: capture host ⇄ `pi-acp@0.0.32` ⇄ pi ⇄ this
extension, with no adapter of ours anywhere in the path, holds the boundary for every tool kind —
[`evidence/2026-09-21-composed-piacp/`](evidence/2026-09-21-composed-piacp/CAPTURE.md) and, from
the harness this repo now ships,
[`evidence/2026-09-22-composed-in-repo/`](evidence/2026-09-22-composed-in-repo/CAPTURE.md).

So the ~540-line ACP adapter this repo used to carry (`src/acp-agent.ts`, `src/pi-rpc.ts`,
`src/cli.ts`) is gone. It re-implemented in 7 handlers what pi-acp does in 4,238 lines across 17
modules — sessions, resume, structured diffs, terminal streaming, slash and skill commands, auth,
model and thinking modes — and it bought exactly one behaviour pi-acp does not have, recorded
below so it cannot vanish in a diff.

## Use

```
npm ci && npm run build
```

The gate is loaded by flags on the pi process an ACP carrier spawns:

```
pi -ne -e <path>/pi-governance/dist/extension.js …
```

- `-ne` (`--no-extensions`) disables extension **discovery**, so nothing under
  `~/.pi/agent/extensions` can shadow or outrank the gate.
- `-e <path>` loads the gate explicitly. It is the only extension that needs to be there.

pi-acp spawns `pi --mode rpc --no-themes` and contributes no argv of its own, so the flags have to
come from whatever the host names in `PI_ACP_PI_COMMAND`. In the wicked stack that is
wicked-crew's `wicked-pi.mjs` shim, whose `composePiArgv` (wicked-pi.mjs:43) already prepends
flags of exactly this shape for `--skill`.

> **Remaining integration step (not in this repo).** `composePiArgv` does **not** yet emit
> `-ne -e <extension>`. That is ~3 lines on the wicked-crew side. Until it lands, the capture
> stands in for that injection point with `capture/gate-pi.mjs`, which is how the composed runs
> were taken — and the shim itself was used byte-identical, unmodified, in the 2026-09-21 run.

## How it works

pi's extension system exposes a `tool_call` hook that runs **before** pi prepares or executes the
tool, and that can block it. In RPC mode a `ctx.ui.select()` inside that hook becomes an
`extension_ui_request` on pi's stdout that blocks until the embedding process answers on stdin —
the one blocking round-trip an extension has with its host. pi-acp bridges that request to ACP:

```
host ──ACP──▶ pi-acp ──pi --mode rpc──▶ pi
                 │                       │  tool_call hook (blocks)
                 │◀── extension_ui_request ┘
 ◀ session/request_permission ─┤
 ── selected: choice-0 ───────▶│
                 └── extension_ui_response ──▶ pi executes (or does not)
```

Three things a host needs to know:

- **The permission request is not self-describing in ACP-native fields.** pi-acp wraps the
  extension's UI event in a synthetic tool call (`toolCallId` = `pi-ui-<uuid>`, `kind` = `other`).
  The canonical tool name and raw input survive inside the `title`, as this repo's tagged envelope
  `pi-governance/1 {…}` (`src/protocol.ts`). A host must decode that envelope to see what it is
  approving. The real identity and raw input are also on the separate `session/update` `tool_call`
  record, keyed by the same id the envelope carries.
- **Answer by option *name*, not by option id.** pi-acp rewrites option ids to `choice-<index>`,
  so `allow-once` / `reject-once` survive only as the names.
- **Only `allow-once` / `reject-once` are offered.** An "always" answer would let a later tool
  call run with no round-trip, and a boundary that is sometimes silent cannot be audited.

Anything that is not an explicit allow blocks the call: a cancelled dialog, an unknown option id,
a failed request, or a pi started with no host channel at all (`ctx.hasUI === false`).

## Admission

An extension is not trusted because it claims to ask. It is trusted when a capture shows it
asking. The bar:

1. Every tool kind — `read`, `edit`, `write`, `bash` — issues `session/request_permission` before
   execution.
2. A `write` **must not** reach `in_progress` without a permission response.
3. A denial is visible on the wire and the write does not happen.
4. The capture is stored as evidence and cites the exact pi, carrier and extension versions it was
   taken against.

A new pi, carrier or extension version re-runs the capture. A version that has not been captured
is not admitted, however small the change.

### Where it stands on the composed path

Against **pi 0.84.2** + **pi-acp@0.0.32**: 47 of 62 checks pass
([`evidence/2026-09-22-composed-in-repo/`](evidence/2026-09-22-composed-in-repo/CAPTURE.md)), plus
8 of 8 in the real-model corroboration.

| Point | Verdict |
|---|---|
| 1. every tool kind asks before it runs | **PASS** |
| 2. a `write` does not reach `in_progress` without a response | **FAIL** — see below |
| 3. a denial is on the wire and the write does not happen | **PASS** — judged on disk |
| 4. captured, with versions | **PASS** |

**Point 2 currently fails on the composed path, for every tool kind — not just `write`.** All 15
failing checks are that one defect. The boundary itself holds in every run: a denied write is
absent from disk, a cancelled request blocks, and each of two sibling calls gets its own ask and
its own answer. What fails is the *status* a host sees while the call is suspended.

With the carrier fix ([svkozak/pi-acp#137](https://github.com/svkozak/pi-acp/pull/137)) applied,
the same six scenarios score **62/62** — the bar is met in full, and nothing in this repo changes
to meet it.

## The one thing the deleted adapter did that pi-acp does not

`pi` emits `tool_execution_start` **before** it runs the hook. In
`@earendil-works/pi-agent-core/dist/agent-loop.js` (pi 0.84.2), `executeToolCallsSequential` emits
at ~line 300 and only then awaits `prepareToolCall` at ~line 305; `executeToolCallsParallel` does
the same at ~336/341; the extension's hook (`config.beforeToolCall`) runs inside `prepareToolCall`
at ~line 405, and a `block` short-circuits the call there.

So that event means *"pi intends to run this"*, not *"pi is running this"*. The removed adapter
mapped it to ACP `pending` and emitted `in_progress` only after an allow came back. pi-acp maps it
straight to `in_progress`. **That single mapping is the only behaviour the 540 deleted lines
provided that the composed path does not** — and deleting them is what makes admission point 2
fail here while it passes in
[`evidence/2026-09-22-standalone-adapter/`](evidence/2026-09-22-standalone-adapter/CAPTURE.md).

The mapping belongs in the carrier, not in a second adapter kept alive to hold one line, so it has
been taken upstream: **[svkozak/pi-acp#137](https://github.com/svkozak/pi-acp/pull/137)** maps
`tool_execution_start` to `pending` and lets `tool_execution_update` — output from a tool that is
genuinely running — mean `in_progress`.

That is not a hope; it is measured. Run against a build of that branch
(`PIGOV_CARRIER=<candidate>/dist/index.js`), the same six scenarios go from 47/62 to **62/62**:
admission point 2 passes for every tool kind, with no adapter of ours in the path —
[`evidence/2026-09-22-composed-in-repo/patched-carrier/`](evidence/2026-09-22-composed-in-repo/patched-carrier/summary.json).

Until it lands, a host reading pi-acp's `in_progress` must not treat it as "the tool is running".
The authoritative signal that a call was allowed is the permission response the host itself sent,
and the capture asserts ordering against that, not against the status.

## Two defects in pi-acp, found by the proof

Both verified against `pi-acp@0.0.32` (gitHead `2f6e3c5`) and still present on `main` (0.0.33).
Both are fixed in [svkozak/pi-acp#137](https://github.com/svkozak/pi-acp/pull/137).

### 1. `in_progress` is reported before the hook has run

`src/acp/session.ts:612` `case 'tool_execution_start'` sets `currentToolCalls` to `in_progress`
and emits status `in_progress` (non-bash at `:659-681`, bash at `:619-632`), faithfully mapping
pi's event — which pi emits before the gate. A tool call that is suspended at a permission
boundary is reported to the host as running. Verbatim from `composed-allow/wire.jsonl`:

```
 8 agent->host update tool_call        id=scripted-0-read status=pending
 9 agent->host update tool_call_update id=scripted-0-read status=in_progress
10 agent->host REQ_PERMISSION          … "toolName":"read" …
11 host->agent RESULT                  {"outcome":{"outcome":"selected","optionId":"choice-0"}}
```

The order of the ask against the `in_progress` for the same call is also **not stable run to
run** — they come from two independent paths inside the carrier — so a host cannot compensate by
relying on ordering either.

### 2. Every select option is stamped `kind: 'allow_once'` — including the rejection

`src/acp/session.ts:913-917` (`handleExtensionSelect`) maps the extension's options to
`{ optionId: 'choice-<index>', name, kind: 'allow_once' }` — the `kind` is hardcoded, for every
option. The offer recorded on the wire, from a real-model run:

```
"offered": ["choice-0:allow-once:allow_once", "choice-1:reject-once:allow_once"]
```

Rejection works in these captures only because the host answers by option **name**. **A host that
routes on the ACP `kind` field reads a rejection as an approval.** That is a permission dialog
whose "no" is typed as "yes", and it is the more dangerous of the two: defect 1 misreports a
status, defect 2 can execute a tool the user declined.

Evidence: [`evidence/2026-09-22-composed-in-repo/real-model/real-model-deny/result.json`](evidence/2026-09-22-composed-in-repo/real-model/real-model-deny/result.json)
(the deny run: both options offered as `allow_once`, `hello.txt` absent from disk afterwards).

## The capture

```
npm ci && npm run build
node capture/capture.mjs                      # 6 scenarios against pi-acp as the carrier
node capture/capture.mjs --only composed-allow # one scenario
node capture/real-model.mjs                   # corroboration, needs `ollama serve` + llama3.2:3b
node capture/aggregate.mjs <out-dir>          # fold per-scenario summaries into summary.json
node capture/bundle.mjs <out-dir> evidence/<date>   # redact machine-local paths, fail on leaks
node capture/timeline.mjs <out-dir>/<scenario>/wire.jsonl
```

`capture/capture.mjs` runs the real `pi` binary under the real `pi-acp` over a real ACP stdio
connection, records every JSON-RPC line in both directions, then judges the recording. Disk state
is read back from the file system; a "denied" message on the wire is never accepted as evidence
that bytes were not written.

Two environment variables change the stack without changing the bar:
`PIGOV_PI_SHIM=<path to wicked-pi.mjs>` reproduces the production shape with wicked-crew's shim
spliced in; `PIGOV_CARRIER=<path>/dist/index.js` judges a candidate carrier — which is how
`patched-carrier/` was taken. The summary records which carrier package it actually loaded, so an
overridden run cannot be filed under the pinned version.

It is built to fail loudly, because an empty capture reads exactly like a passing one. A recording
that is empty or short, a missing composed-path component, a child that dies, a turn that never
completes, an undecodable permission request, a scenario or assertion count that does not match
the expected one, and a run that ends without reaching a verdict all exit non-zero and say which.

**The harness has been seen failing.** Two mutations against the harness as it ships —
`PIPROOF_REAL_PI=/nonexistent/pi` (exit 1, 1/11) and a gate that asks and then ignores the answer
(exit 1, 7/12: the denial is on the wire and the capture still fails, because `written.txt` is on
disk) — are recorded in
[`evidence/2026-09-22-composed-in-repo/CAPTURE.md`](evidence/2026-09-22-composed-in-repo/CAPTURE.md).
Three earlier ones, including an extension that never asks, are in
[`evidence/2026-09-22-standalone-adapter/CAPTURE.md`](evidence/2026-09-22-standalone-adapter/CAPTURE.md).
One of those found a real bug in the first version of this harness: a dead adapter left the turn's
promise unsettled, so the run waited out its timeout and exited **0** — an empty capture that read
as a pass. That is why the exit guard and the check-count guard exist.

Scenarios: `composed-allow`, `composed-deny-write`, `composed-cancel-write` (fail-closed),
`composed-negative-control` (gate not loaded — zero round-trips, the write lands), and
`composed-parallel-{allow,deny-b}` (two sibling writes in one turn, answered per call). The model
is scripted (`capture/scripted-provider.ts`, `capture/parallel-provider.ts`) so the tool kinds
appear in a fixed order; pi, its tools, the extension hook, the carrier and the ACP wire are all
real. There is no capture against a hosted frontier model.

## Design notes

- **Defence in depth, not either/or.** pi also offers `--tools`, `--exclude-tools` and
  `--no-builtin-tools`. For a read-only context, withholding the write tools is a stronger
  guarantee than a prompt that must be both asked *and* honoured. This extension does not replace
  that; the two compose.
- **Why an extension.** pi's extension system is what puts the boundary *inside* the tool
  pipeline, which is the only place it can be authoritative. A wrapper that watches a stream can
  describe what happened; it cannot withhold consent.
- **Why not our own adapter.** A carrier is a large, moving surface — sessions, resume, diffs,
  terminals, slash commands, auth, modes. Re-implementing it to own a gate means re-implementing
  it forever. Upstreaming a mapping is cheaper than maintaining a fork of the world it lives in.
- **No "always" answers, no allowlist, no fast path.** Every call asks.

Layout: `src/extension.ts` is the hook, `src/protocol.ts` is the envelope a host decodes,
everything under `capture/` produces `evidence/`.

## License

MIT
