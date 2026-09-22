# Composed capture: the extension alone, carried by `pi-acp`

This capture answers one question: does `src/extension.ts` produce real ACP permission
round-trips when the carrier is the community `pi-acp` adapter instead of this repo's own
adapter? If it does, the adapter under `src/acp-agent.ts` / `src/pi-rpc.ts` / `src/cli.ts`
is redundant.

**None of this repo's adapter code is in the path.** The only thing loaded from here is
`dist/extension.js` (compiled from `src/extension.ts`), plus the capture-only scripted model
providers.

## The stack

```
capture host (ACP client, @zed-industries/agent-client-protocol 0.4.5)
  ⇄ stdio ⇄ pi-acp@0.0.32                      (the version wicked-crew resolves)
    ── PI_ACP_PI_COMMAND ─▶ wicked-crew's wicked-pi.mjs   (byte-identical copy, unmodified;
                                                           sha256 aaa2e87d…9c6dab0)
      ── WICKED_PI_BINARY ─▶ harness/gate-pi.mjs          (prepends the gate flags)
        ──▶ pi 0.84.2 with the argv below
```

`pi-acp` spawns `pi --mode rpc --no-themes` and forwards no argv of its own
(`src/pi-rpc/process.ts` at v0.0.32), so the gate flags have to be prepended by whatever the
host names as the pi command. `wicked-pi.mjs:43 composePiArgv` already does exactly that for
`--skill`; `gate-pi.mjs` stands in for the same injection point so the shim could be copied
unmodified. The argv pi actually received (recorded per scenario in `pi-argv.jsonl`):

```
pi --no-session --no-context-files -ne \
   -e <PI-GOVERNANCE-CHECKOUT>/dist/extension.js \
   -e <PI-GOVERNANCE-CHECKOUT>/capture/scripted-provider.ts \
   --provider pigov-capture --model pigov-capture/scripted \
   --mode rpc --no-themes
```

`-ne` (`--no-extensions`) disables extension discovery, so nothing can shadow the gate; the
two `-e` flags load the gate and the scripted provider explicitly.

## Result

`summary.json`: **50/62 checks passed across 6 scenarios.** All 12 failures are one defect
(below). Every scenario has its full JSON-RPC recording in `<scenario>/wire.jsonl` and its
end-state files in `<scenario>/work/`, read back off disk rather than inferred from the log.

| Admission point | Verdict |
|---|---|
| read / edit / write / bash each issue `session/request_permission` | **PASS** — 4 asks per sequential turn, envelope carries tool name + raw input |
| a `write` does not reach `in_progress` without a response | **FAIL** — and so do read, bash and edit (see below) |
| a denial is visible on the wire and the write does not happen | **PASS** — `written.txt` absent on disk; reject at `composed-deny-write` seq 28 |
| a cancelled / unanswerable request blocks (fail-closed) | **PASS** — `composed-cancel-write`, `written.txt` absent on disk |
| negative control: extension not loaded | **PASS** — 0 permission requests, write lands |
| two sibling tool calls in one turn are each asked and each answer routed correctly | **PASS** — allow A / deny B leaves A on disk and B absent |

## The defect: `in_progress` before the ask

`pi` emits `tool_execution_start` **before** it runs the `tool_call` hook — in
`@earendil-works/pi-agent-core/dist/agent-loop.js`, both `executeToolCallsSequential`
(~line 296) and `executeToolCallsParallel` (~line 330) `emit({type:'tool_execution_start'…})`
and only then `await prepareToolCall(...)`, which is where `config.beforeToolCall` (the
extension's hook) runs and where a `block` short-circuits the call (~line 419).

`pi-acp` maps that event straight to ACP `in_progress` (`src/acp/session.ts` v0.0.32, case
`tool_execution_start`). The result, verbatim from `composed-allow/wire.jsonl`:

```
 8 agent->host update tool_call        id=scripted-0-read status=pending
 9 agent->host update tool_call_update id=scripted-0-read status=in_progress
10 agent->host REQ_PERMISSION          … "toolCallId":"scripted-0-read","toolName":"read" …
11 host->agent RESULT                  {"outcome":{"outcome":"selected","optionId":"choice-0"}}
12 agent->host update tool_call_update id=scripted-0-read status=completed
```

and for the write, `in_progress` lands while the ask is still outstanding:

```
25 agent->host REQ_PERMISSION          … "toolCallId":"scripted-3-write","toolName":"write" …
26 agent->host update tool_call        id=scripted-3-write status=pending
27 agent->host update tool_call_update id=scripted-3-write status=in_progress
28 host->agent RESULT                  {"outcome":{"outcome":"selected","optionId":"choice-1"}}
29 agent->host update tool_call_update id=scripted-3-write status=failed
    content: "pi-governance: write denied by host (reject-once)"
```

The status is wrong; the boundary is not. `composed-deny-write/work/` has no `written.txt` —
the denied write never ran. This repo's own adapter maps `tool_execution_start` to `pending`
instead, which is why the same assertions pass there and fail here.

## Two more carrier-level notes

1. **The permission request is not self-describing in ACP-native fields.** `pi-acp` wraps the
   extension's UI event in a synthetic tool call: `toolCallId` is `pi-ui-<uuid>`, `kind` is
   `other`, and the canonical tool name and raw input survive only inside the `title` string
   (this repo's `pi-governance/1 {…}` envelope). A host must know that envelope to see what it
   is approving. `pi-acp` does put the real identity and raw input on the separate
   `session/update` `tool_call` record (`title` = tool name, `rawInput` = args), keyed by the
   same id the envelope carries.
2. **Both options are labelled `allow_once`.** `pi-acp` rewrites option ids to
   `choice-<index>` and hardcodes `kind: 'allow_once'` for every one of them
   (`src/acp/session.ts` v0.0.32, `handleExtensionSelect`), so the recorded offer is
   `choice-0:allow-once:allow_once` and `choice-1:reject-once:allow_once`. Rejection works —
   it is answered by option *name* — but a host that routes on the ACP `kind` field would read
   a rejection as an approval.

## Parallel tool calls

`composed-parallel-*` uses a scripted provider that emits two `write` calls to different paths
in one assistant message, and the host holds every ask open for 400 ms. The asks did **not**
overlap (`maxInFlightAsks=1`): pi preflights siblings sequentially — the second
`tool_execution_start`/ask only appears after the first ask is answered — and only then runs
both executions. So `pi-acp`'s per-id bridge is never asked to hold two in-flight permission
requests through this path. What is proven is that each ask is matched to its own call and each
answer routes back correctly: in `composed-parallel-deny-b`, A is allowed and B rejected, and
`work/` contains `parallel-a.txt` and no `parallel-b.txt`.

## Reproducing

The harness lives in `harness/` and was run from a working directory laid out as

```
<workdir>/piproof/{capture-composed.mjs,gate-pi.mjs,parallel-provider.ts,bridges/wicked-pi.mjs,node_modules/pi-acp@0.0.32}
<workdir>/pigov/pi-governance        (this repo, built: npm run build)
```

```
node capture-composed.mjs --only <scenario>     # one scenario, exits non-zero on any failure
node aggregate.mjs evidence                     # fold per-scenario summaries into summary.json
node timeline.mjs evidence/<scenario>/wire.jsonl
```

The harness fails loudly by construction: fewer than 8 wire records or 4 JSON-RPC methods, a
missing scenario, an undecodable permission request, a crashed child, or a check count that
does not match the expected count all exit non-zero. Verified by mutation: with
`PIPROOF_REAL_PI=/nonexistent/pi` the run exits 1 with 10 of 11 checks FAIL, not a silent pass.
