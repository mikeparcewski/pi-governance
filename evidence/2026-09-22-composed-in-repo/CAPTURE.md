# Capture: the shipped harness, after the adapter was deleted

This is the same composed capture as [`../2026-09-21-composed-piacp/CAPTURE.md`](../2026-09-21-composed-piacp/CAPTURE.md),
re-run from the harness this repo now ships (`capture/capture.mjs`) after `src/acp-agent.ts`,
`src/pi-rpc.ts` and `src/cli.ts` were removed. Its whole point is that the numbers did not move:
nothing that was deleted was in the path that produced them.

## The stack

```
capture host (ACP client, @zed-industries/agent-client-protocol 0.4.5)
  ⇄ stdio ⇄ pi-acp@0.0.32                 node_modules/pi-acp/dist/index.js
    ── PI_ACP_PI_COMMAND ─▶ capture/gate-pi.mjs   (prepends the gate flags)
      ──▶ pi 0.84.2, argv recorded per scenario in `<scenario>/pi-argv.jsonl`:

pi --no-session --no-context-files -ne \
   -e <PI-GOVERNANCE-CHECKOUT>/dist/extension.js \
   -e <PI-GOVERNANCE-CHECKOUT>/capture/scripted-provider.ts \
   --provider pigov-capture --model pigov-capture/scripted \
   --mode rpc --no-themes
```

The only pi-governance code in the path is `dist/extension.js`, compiled from `src/extension.ts`,
plus the capture-only model providers. `-ne` disables extension discovery so nothing can shadow
the gate; the `-e` flags load the gate and the provider explicitly.

The 2026-09-21 run put wicked-crew's `wicked-pi.mjs` between the carrier and gate-pi to prove the
shim needs no edit. This run leaves it out (`PIGOV_PI_SHIM` unset) and gets the same result, so
the shim is a production detail, not a condition of the boundary. `summary*.json` records which
was used in its `shim` field.

## Result

`summary.json`: **47/62 checks passed across 6 scenarios.** All 15 failures are the one defect
below — `in_progress` before the ask. Every other admission point passes, on the wire and on disk.

| Admission point | Verdict |
|---|---|
| read / edit / write / bash each issue `session/request_permission` | **PASS** — 4 asks per sequential turn |
| a `write` does not reach `in_progress` without a response | **FAIL** — and so do read, bash and edit |
| a denial is visible on the wire and the write does not happen | **PASS** — `written.txt` absent on disk |
| a cancelled / unanswerable request blocks (fail-closed) | **PASS** — `composed-cancel-write` |
| negative control: extension not loaded | **PASS** — 0 permission requests, write lands |
| two sibling calls in one turn, each asked, each answer routed | **PASS** — A on disk, B absent |

### 47/62 here, 50/62 on 2026-09-21 — same defect, looser ordering

On 2026-09-21 the `write`'s permission request happened to reach the host *before* pi-acp's
`in_progress` for the same call, so `write-requests-permission` passed in the three sequential
scenarios. Here it lands *after* it, so that check fails too (3 scenarios × 1 check = the 3-check
difference). Nothing else changed:

```
FAIL composed-allow write-requests-permission                       request@27 firstExecutionSignal@26
FAIL composed-allow write-in-progress-only-after-permission-response request@27 answer@28 in_progress@[26]
```

The order of those two is not stable run to run, which is itself the finding: **a host cannot
rely on the ordering of the status update and the ask**, because they are produced by two
independent paths inside the carrier. The boundary itself is unaffected — the denied write is
still absent from disk in every run.

## The defect (unchanged)

`pi` emits `tool_execution_start` **before** it runs the `tool_call` hook
(`@earendil-works/pi-agent-core/dist/agent-loop.js`: `executeToolCallsSequential` emits at ~line
300 and awaits `prepareToolCall` at ~line 305; `executeToolCallsParallel` the same at ~336/341;
`config.beforeToolCall` — the extension's hook — runs inside `prepareToolCall` at ~line 405 and a
`block` short-circuits there). `pi-acp` maps that event straight to ACP `in_progress`
(`src/acp/session.ts`, `case 'tool_execution_start'`), so ACP reports "running" for a call that is
still suspended at the gate.

The status is wrong; the boundary is not.

## Real-model corroboration: `real-model/`

`capture/real-model.mjs`, same composed stack, a real model (llama3.2:3b on a local Ollama
server) choosing its own tool call instead of a scripted provider: **8/8 checks passed** —
the write is asked about before it runs in both modes, `hello.txt` contains `CANARY` after an
allow and is absent after a deny.

`real-model/real-model-deny/result.json` also records the carrier's option list verbatim:

```
"offered": ["choice-0:allow-once:allow_once", "choice-1:reject-once:allow_once"]
```

Both options are stamped `kind: allow_once` by `pi-acp` — including the rejection. This host
answers by option *name*, so the denial was honoured. A host that routed on the ACP `kind` field
would have read that rejection as an approval.

## With the carrier fix applied: `patched-carrier/` — 62/62

The same six scenarios, same pi, same extension, run against a `pi-acp` build carrying the
proposed fix (`tool_execution_start` → `pending`; `in_progress` on `tool_execution_update`, where
the tool is actually producing output), loaded with `PIGOV_CARRIER=<candidate>/dist/index.js`:

```
62/62 checks passed across 6 scenarios          carrier: pi-acp@0.0.33 (patched)
PASS composed-allow write-in-progress-only-after-permission-response  request@25 answer@28 in_progress@[]
PASS composed-allow read-requests-permission                          request@10 firstExecutionSignal@12
```

Admission point 2 passes, for every tool kind, with **no adapter of ours in the path**. That is
the whole case for fixing it in the carrier rather than keeping 540 lines alive to hold one
mapping. The remaining nuance is visible in the check detail: `in_progress@[]` — a tool that
streams no partial output now goes `pending → completed`, because after the fix nothing claims
execution started until output arrives. `bash`, which streams, still reports `in_progress`.

Evidence: [`patched-carrier/summary.json`](patched-carrier/summary.json) and the per-scenario
wire recordings beside it.

## Has the shipped harness been seen failing?

A capture that has never failed proves nothing about what it would catch. Two mutations were run
against `capture/capture.mjs` as it ships here, after the move out of the scratch layout:

| Mutation | Result |
|---|---|
| `PIPROOF_REAL_PI=/nonexistent/pi` (pi cannot start) | exit **1**, 1/11 — `capture-is-non-empty records=4 methods=2`, `prompt-completed stopReason=undefined`, all four tool calls "never appeared on the wire" |
| Gate asks, then ignores the answer (`dist/extension.js`: `if (false && choice !== ALLOW_OPTION_ID)`) | exit **1**, 7/12 on `composed-deny-write` — `denial-visible-on-the-wire` still **PASS**, `disk-written.txt on disk: "CANARY-WRITE\n"` **FAIL** |

The second is the one that matters: the denial was on the wire, and the capture still failed,
because disk state is read back from the file system and never inferred from the log. A wire
message saying "denied" buys nothing here.

Both mutations were reverted before this evidence was taken; the run above is from the unmutated
build (`npm run build`).

## What this does not establish

- Nothing about a hosted frontier model; the corroboration is one 3B local model.
- Nothing about pi-acp's own surface beyond the gate (sessions, resume, slash commands, auth,
  terminals) — this capture exercises the permission path only.
- Nothing about concurrency beyond two siblings: `maxInFlightAsks` is 1 in every run, because pi
  preflights sibling tool calls sequentially. The carrier's bridge has never been asked to hold
  two permission requests open at once through this path.
- Nothing about wicked-crew's `composePiArgv`, which does not yet emit `-ne -e <extension>`.
  gate-pi.mjs stands in for that injection point here.

## Reproducing

```
npm ci && npm run build
node capture/capture.mjs --only composed-allow      # one scenario; non-zero on any failure
node capture/aggregate.mjs <out-dir>                # fold per-scenario summaries into summary.json
node capture/bundle.mjs <out-dir> evidence/<date>   # redact machine-local paths, fail on leaks
node capture/timeline.mjs <out-dir>/<scenario>/wire.jsonl
```

Set `PIGOV_PI_SHIM=<path to wicked-pi.mjs>` to reproduce the production shape with crew's shim
spliced in.
