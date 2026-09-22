#!/usr/bin/env node
/**
 * The admission capture.
 *
 * The carrier is `pi-acp` — the community ACP adapter — and the only pi-governance code in the
 * path is the gate extension (`src/extension.ts`, compiled to `dist/extension.js`):
 *
 *   capture host (ACP client)
 *     ⇄ stdio ⇄ pi-acp                                        node_modules/pi-acp/dist/index.js
 *       ── PI_ACP_PI_COMMAND ─▶ gate-pi.mjs                    (prepends the gate flags)
 *           ──▶ real pi, `-ne -e <dist/extension.js>`
 *
 * With PIGOV_PI_SHIM set (wicked-crew's `wicked-pi.mjs`, unmodified) the shim is spliced in as
 * PI_ACP_PI_COMMAND and gate-pi becomes its WICKED_PI_BINARY — the production shape, where
 * `composePiArgv` is what contributes `-ne -e <extension>` instead of gate-pi. Either way the
 * argv pi actually received is recorded per scenario in `pi-argv.jsonl`.
 *
 * Built to fail loudly: an empty or short recording, a missing scenario, a crashed child, an
 * undecodable permission request, or an assertion count that does not match the expected count
 * all exit non-zero. "No output" must never read like "all checks passed".
 *
 *   node capture/capture.mjs [--out <dir>] [--only <scenario>]
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ClientSideConnection, ndJsonStream } from "@zed-industries/agent-client-protocol";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
/**
 * The ACP carrier. Defaults to the pinned pi-acp in node_modules; PIGOV_CARRIER points it at a
 * candidate build instead, which is how a proposed carrier fix is judged against the same bar.
 */
const CARRIER = process.env.PIGOV_CARRIER
	? resolve(process.env.PIGOV_CARRIER)
	: join(REPO, "node_modules", "pi-acp", "dist", "index.js");
/** Optional: wicked-crew's `wicked-pi.mjs`, used verbatim when it is available. */
const SHIM = process.env.PIGOV_PI_SHIM ? resolve(process.env.PIGOV_PI_SHIM) : null;
const GATE_PI = join(HERE, "gate-pi.mjs");
const EXTENSION = join(REPO, "dist", "extension.js");
const SEQ_PROVIDER = join(HERE, "scripted-provider.ts");
const PAR_PROVIDER = join(HERE, "parallel-provider.ts");

const ENVELOPE_TAG = "pi-governance/1";
const ALLOW = "allow-once";
const REJECT = "reject-once";
const SEED = "ORIGINAL line under governance\n";
const TIMEOUT_MS = 240_000;

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

/** The scripted providers assign deterministic tool call ids; pi-acp forwards them verbatim. */
const SEQ_IDS = {
	read: "scripted-0-read",
	bash: "scripted-1-bash",
	edit: "scripted-2-edit",
	write: "scripted-3-write",
};
const PAR_IDS = { a: "scripted-par-parallel-a.txt", b: "scripted-par-parallel-b.txt" };

const SCENARIOS = [
	{
		name: "composed-allow",
		governed: true,
		provider: SEQ_PROVIDER,
		prompt: "Read target.txt, run echo, edit target.txt, then write written.txt.",
		decide: () => ALLOW,
		expect: { "target.txt": "EDITED line under governance\n", "written.txt": "CANARY-WRITE\n" },
		kind: "sequential",
	},
	{
		name: "composed-deny-write",
		governed: true,
		provider: SEQ_PROVIDER,
		prompt: "Read target.txt, run echo, edit target.txt, then write written.txt.",
		decide: (env) => (env?.toolName === "write" ? REJECT : ALLOW),
		expect: { "target.txt": "EDITED line under governance\n", "written.txt": null },
		kind: "sequential",
	},
	{
		name: "composed-negative-control",
		governed: false,
		provider: SEQ_PROVIDER,
		prompt: "Read target.txt, run echo, edit target.txt, then write written.txt.",
		decide: () => ALLOW,
		expect: { "target.txt": "EDITED line under governance\n", "written.txt": "CANARY-WRITE\n" },
		kind: "sequential",
	},
	{
		// Fail-closed: the host answers nothing usable (ACP `cancelled`). The gate must block.
		name: "composed-cancel-write",
		governed: true,
		provider: SEQ_PROVIDER,
		prompt: "Read target.txt, run echo, edit target.txt, then write written.txt.",
		decide: (env) => (env?.toolName === "write" ? "(cancel)" : ALLOW),
		expect: { "target.txt": "EDITED line under governance\n", "written.txt": null },
		kind: "sequential",
	},
	{
		name: "composed-parallel-allow",
		governed: true,
		provider: PAR_PROVIDER,
		prompt: "Write parallel-a.txt and parallel-b.txt in one step.",
		decide: () => ALLOW,
		expect: { "parallel-a.txt": "A-CONTENT\n", "parallel-b.txt": "B-CONTENT\n" },
		kind: "parallel",
	},
	{
		name: "composed-parallel-deny-b",
		governed: true,
		provider: PAR_PROVIDER,
		prompt: "Write parallel-a.txt and parallel-b.txt in one step.",
		// Routing test: the answer is keyed on the PATH, not the tool kind — both calls are writes.
		decide: (env) => (String(env?.rawInput?.path ?? "").includes("-b") ? REJECT : ALLOW),
		expect: { "parallel-a.txt": "A-CONTENT\n", "parallel-b.txt": null },
		kind: "parallel",
	},
];

function decodeEnvelope(title) {
	if (typeof title !== "string" || !title.startsWith(`${ENVELOPE_TAG} `)) return undefined;
	try {
		const parsed = JSON.parse(title.slice(ENVELOPE_TAG.length + 1));
		if (parsed?.v !== 1 || typeof parsed.toolCallId !== "string") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// one scenario run
// ---------------------------------------------------------------------------

async function runScenario(scenario, outDir) {
	const workDir = mkdtempSync(join(tmpdir(), `piproof-${scenario.name}-`));
	rmSync(join(outDir, scenario.name), { recursive: true, force: true });
	mkdirSync(join(outDir, scenario.name), { recursive: true });
	writeFileSync(join(workDir, "target.txt"), SEED);

	const wirePath = join(outDir, scenario.name, "wire.jsonl");
	writeFileSync(wirePath, "");
	const stderrPath = join(outDir, scenario.name, "stderr.log");
	writeFileSync(stderrPath, "");
	const argvPath = join(outDir, scenario.name, "pi-argv.jsonl");
	writeFileSync(argvPath, "");

	const records = [];
	let seq = 0;
	const recordLine = (direction, line) => {
		if (!line.trim()) return;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			msg = { unparseable: line };
		}
		const entry = { seq: seq++, ts: new Date().toISOString(), direction, msg };
		records.push(entry);
		appendFileSync(wirePath, `${JSON.stringify(entry)}\n`);
	};

	// The gate flags. In production these come from wicked-pi's composePiArgv; here they are
	// injected by gate-pi.mjs, so a shim under test stays byte-identical to crew's copy.
	//   -ne          : no extension discovery, so nothing can shadow the gate
	//   -e <ext>     : the pi-governance gate extension (omitted in the negative control)
	//   -e <provider>: the capture-only scripted model provider
	const piFlags = ["--no-session", "--no-context-files", "-ne"];
	if (scenario.governed) piFlags.push("-e", EXTENSION);
	piFlags.push("-e", scenario.provider, "--provider", "pigov-capture", "--model", "pigov-capture/scripted");

	const env = {
		...process.env,
		// pi-acp spawns whatever PI_ACP_PI_COMMAND names. Without a shim that is gate-pi
		// directly; with one, the shim is the command and gate-pi is the pi it runs.
		PI_ACP_PI_COMMAND: SHIM ?? GATE_PI,
		WICKED_PI_BINARY: GATE_PI,
		PIPROOF_PI_FLAGS: JSON.stringify(piFlags),
		PIPROOF_ARGV_LOG: argvPath,
		// keep pi quiet and deterministic
		NO_COLOR: "1",
	};
	delete env.WICKED_PI_SKILL_DIRS;

	const child = spawn(process.execPath, [CARRIER], { stdio: ["pipe", "pipe", "pipe"], env });
	child.stderr.on("data", (chunk) => appendFileSync(stderrPath, chunk.toString("utf8")));

	const framed = (direction) => {
		let buffer = "";
		return (chunk) => {
			buffer += Buffer.from(chunk).toString("utf8");
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				recordLine(direction, buffer.slice(0, index));
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
			}
		};
	};

	const logAgentToHost = framed("agent->host");
	const readable = Readable.toWeb(child.stdout).pipeThrough(
		new TransformStream({
			transform(chunk, controller) {
				logAgentToHost(chunk);
				controller.enqueue(chunk);
			},
		}),
	);

	const logHostToAgent = framed("host->agent");
	const stdinWriter = Writable.toWeb(child.stdin).getWriter();
	const writable = new WritableStream({
		async write(chunk) {
			logHostToAgent(chunk);
			await stdinWriter.write(chunk);
		},
		async close() {
			await stdinWriter.close();
		},
	});

	const permissions = [];
	const undecodable = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const client = {
		async requestPermission(params) {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				const title = params.toolCall?.title ?? params.toolCall?.rawInput?.title;
				const envelope = decodeEnvelope(title);
				if (!envelope) {
					// A permission request this host cannot understand is a failure, not a pass.
					undecodable.push({ toolCallId: params.toolCall?.toolCallId, title: String(title).slice(0, 200) });
					return { outcome: { outcome: "cancelled" } };
				}
				const wanted = scenario.decide(envelope);
				// pi-acp renames the extension's option ids to `choice-<index>`; the original id
				// survives only as the option NAME. Answer by name, the way any host must.
				const option = (params.options ?? []).find((o) => o.name === wanted);
				permissions.push({
					uiToolCallId: params.toolCall?.toolCallId,
					piToolCallId: envelope.toolCallId,
					toolName: envelope.toolName,
					path: envelope.rawInput?.path ?? envelope.rawInput?.command ?? null,
					answeredName: wanted,
					answeredOptionId: option?.optionId ?? null,
					offered: (params.options ?? []).map((o) => `${o.optionId}:${o.name}:${o.kind}`),
				});
				if (!option) return { outcome: { outcome: "cancelled" } };
				// Deliberate: hold every ask open until all siblings have arrived, so overlapping
				// in-flight requests are the tested condition rather than an accident of timing.
				if (scenario.kind === "parallel") await new Promise((r) => setTimeout(r, 400));
				return { outcome: { outcome: "selected", optionId: option.optionId } };
			} finally {
				inFlight -= 1;
			}
		},
		async sessionUpdate() {},
		async writeTextFile() {
			throw new Error("fs/write_text_file not offered by this capture host");
		},
		async readTextFile() {
			throw new Error("fs/read_text_file not offered by this capture host");
		},
	};

	const connection = new ClientSideConnection(() => client, ndJsonStream(writable, readable));

	let timeout;
	const aborted = new Promise((_, reject) => {
		child.on("exit", (code, signal) =>
			reject(new Error(`carrier exited before the turn finished (code=${code} signal=${signal})`)),
		);
		timeout = setTimeout(() => {
			appendFileSync(stderrPath, "\ncapture: TIMEOUT\n");
			child.kill("SIGKILL");
			reject(new Error(`scenario timed out after ${TIMEOUT_MS}ms`));
		}, TIMEOUT_MS);
	});
	aborted.catch(() => {});

	const turn = async () => {
		await connection.initialize({
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
		});
		const session = await connection.newSession({ cwd: workDir, mcpServers: [] });
		return await connection.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: scenario.prompt }],
		});
	};

	let error;
	let stopReason;
	try {
		const result = await Promise.race([turn(), aborted]);
		stopReason = result.stopReason;
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		clearTimeout(timeout);
		child.kill();
	}

	// Disk state is read back from the file system, never inferred from the log.
	const recordDir = join(outDir, scenario.name, "work");
	mkdirSync(recordDir, { recursive: true });
	const disk = {};
	for (const name of Object.keys(scenario.expect)) {
		const path = join(workDir, name);
		if (!existsSync(path)) {
			disk[name] = null;
			continue;
		}
		const content = readFileSync(path, "utf8");
		writeFileSync(join(recordDir, name), content);
		disk[name] = content;
	}
	rmSync(workDir, { recursive: true, force: true });

	return {
		scenario,
		records,
		permissions,
		undecodable,
		maxInFlight,
		stopReason,
		error,
		wirePath,
		stderrPath,
		stderr: existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "",
		piArgv: existsSync(argvPath) ? readFileSync(argvPath, "utf8").trim() : "",
		disk,
	};
}

// ---------------------------------------------------------------------------
// assertions (indexes are positions in the recorded wire, so ordering is on the wire)
// ---------------------------------------------------------------------------

function permissionRequests(records) {
	return records
		.map((r, index) => ({ r, index }))
		.filter(({ r }) => r.direction === "agent->host" && r.msg?.method === "session/request_permission");
}

function indexOfPermissionRequestFor(records, piToolCallId) {
	const hit = permissionRequests(records).find(({ r }) => {
		const tc = r.msg?.params?.toolCall;
		const envelope = decodeEnvelope(tc?.title ?? tc?.rawInput?.title);
		return envelope?.toolCallId === piToolCallId;
	});
	return hit ? hit.index : -1;
}

function indexOfPermissionResponse(records, requestIndex) {
	const id = records[requestIndex]?.msg?.id;
	if (id === undefined) return -1;
	return records.findIndex((r) => r.direction === "host->agent" && r.msg?.id === id && "result" in r.msg);
}

function toolUpdateIndexes(records, toolCallId, status) {
	const found = [];
	records.forEach((r, index) => {
		const update = r.msg?.params?.update;
		if (r.direction !== "agent->host") return;
		if (r.msg?.method !== "session/update") return;
		if (update?.toolCallId !== toolCallId) return;
		if (update?.status !== status) return;
		found.push(index);
	});
	return found;
}

function sawToolCall(records, toolCallId) {
	return records.some(
		(r) =>
			r.direction === "agent->host" &&
			r.msg?.method === "session/update" &&
			r.msg?.params?.update?.toolCallId === toolCallId,
	);
}

function assertScenario(run, checks) {
	const { scenario, records } = run;
	const push = (id, ok, detail) => checks.push({ scenario: scenario.name, id, ok, detail });

	// Guard first: an empty or truncated recording must never read as a pass.
	const methods = records.filter((r) => r.msg?.method);
	push("capture-is-non-empty", records.length >= 8 && methods.length >= 4, `records=${records.length} methods=${methods.length}`);
	push(
		"prompt-completed",
		run.error === undefined && run.stopReason === "end_turn",
		`stopReason=${run.stopReason} error=${run.error ?? "none"}`,
	);
	push("no-undecodable-permission-requests", run.undecodable.length === 0, JSON.stringify(run.undecodable));

	const reqs = permissionRequests(records);

	if (scenario.kind === "sequential") {
		const ids = SEQ_IDS;
		if (scenario.governed) {
			// Admission 1: every tool kind asks before it runs.
			for (const toolName of ["read", "bash", "edit", "write"]) {
				const toolCallId = ids[toolName];
				if (!sawToolCall(records, toolCallId)) {
					push(`${toolName}-requests-permission`, false, `tool call ${toolCallId} never appeared on the wire`);
					continue;
				}
				const requestIndex = indexOfPermissionRequestFor(records, toolCallId);
				const firstExecutionSignal = [
					...toolUpdateIndexes(records, toolCallId, "in_progress"),
					...toolUpdateIndexes(records, toolCallId, "completed"),
					...toolUpdateIndexes(records, toolCallId, "failed"),
				].sort((a, b) => a - b)[0];
				push(
					`${toolName}-requests-permission`,
					requestIndex >= 0 && (firstExecutionSignal === undefined || requestIndex < firstExecutionSignal),
					`request@${requestIndex} firstExecutionSignal@${firstExecutionSignal}`,
				);
			}

			// Admission 2: the write cannot reach in_progress without an answered request.
			const writeRequest = indexOfPermissionRequestFor(records, ids.write);
			const writeAnswer = writeRequest >= 0 ? indexOfPermissionResponse(records, writeRequest) : -1;
			const writeInProgress = toolUpdateIndexes(records, ids.write, "in_progress");
			push(
				"write-in-progress-only-after-permission-response",
				writeRequest >= 0 && writeAnswer > writeRequest && writeInProgress.every((index) => index > writeAnswer),
				`request@${writeRequest} answer@${writeAnswer} in_progress@[${writeInProgress.join(",")}]`,
			);
			push("four-permission-requests", reqs.length === 4, `requests=${reqs.length}`);
		} else {
			push("negative-control-zero-permission-requests", reqs.length === 0, `requests=${reqs.length}`);
			push(
				"negative-control-write-executed",
				toolUpdateIndexes(records, ids.write, "completed").length >= 1,
				`completed@[${toolUpdateIndexes(records, ids.write, "completed").join(",")}]`,
			);
		}
	} else {
		// Parallel: two sibling calls, distinguished only by id / path.
		push("parallel-two-permission-requests", reqs.length === 2, `requests=${reqs.length}`);
		// The substantive guarantee, whether or not the asks overlap: NEITHER sibling may reach a
		// terminal status before the LAST of the two asks has been answered. `maxInFlight` records
		// whether overlap actually occurred (pi preflights siblings sequentially, so it is 1).
		const lastAnswer = Math.max(
			...reqs.map(({ index }) => indexOfPermissionResponse(records, index)),
			-1,
		);
		const terminalBeforeLastAnswer = Object.values(PAR_IDS).flatMap((id) => [
			...toolUpdateIndexes(records, id, "completed"),
			...toolUpdateIndexes(records, id, "failed"),
		]).filter((index) => index < lastAnswer);
		push(
			"parallel-no-sibling-settles-before-both-answers",
			lastAnswer >= 0 && terminalBeforeLastAnswer.length === 0,
			`lastAnswer@${lastAnswer} terminalBefore=[${terminalBeforeLastAnswer.join(",")}] maxInFlightAsks=${run.maxInFlight}`,
		);
		for (const [label, toolCallId] of Object.entries(PAR_IDS)) {
			const requestIndex = indexOfPermissionRequestFor(records, toolCallId);
			const answerIndex = requestIndex >= 0 ? indexOfPermissionResponse(records, requestIndex) : -1;
			push(
				`parallel-${label}-asked-and-answered`,
				requestIndex >= 0 && answerIndex > requestIndex,
				`request@${requestIndex} answer@${answerIndex}`,
			);
		}
		// Routing: each answer must reach the call it was meant for.
		const answeredByPath = new Map(run.permissions.map((p) => [String(p.path), p.answeredName]));
		push(
			"parallel-answers-matched-to-the-right-call",
			answeredByPath.get("parallel-a.txt") !== undefined &&
				answeredByPath.get("parallel-b.txt") !== undefined &&
				answeredByPath.get("parallel-a.txt") === scenario.decide({ toolName: "write", rawInput: { path: "parallel-a.txt" } }) &&
				answeredByPath.get("parallel-b.txt") === scenario.decide({ toolName: "write", rawInput: { path: "parallel-b.txt" } }),
			JSON.stringify(Object.fromEntries(answeredByPath)),
		);
	}

	// Disk state: judged on disk, never on the log.
	for (const [name, expected] of Object.entries(scenario.expect)) {
		push(`disk-${name}`, run.disk[name] === expected, `on disk: ${JSON.stringify(run.disk[name])}`);
	}

	if (scenario.name === "composed-deny-write" || scenario.name === "composed-parallel-deny-b") {
		const denied = run.permissions.filter((p) => p.answeredName === REJECT);
		const rejectOptionIds = new Set(denied.map((p) => p.answeredOptionId));
		const onWire = records.find(
			(r) =>
				r.direction === "host->agent" &&
				r.msg?.result?.outcome?.outcome === "selected" &&
				rejectOptionIds.has(r.msg?.result?.outcome?.optionId),
		);
		push(
			"denial-visible-on-the-wire",
			denied.length >= 1 && onWire !== undefined,
			onWire ? `record seq=${onWire.seq} optionId=${onWire.msg.result.outcome.optionId}` : "no reject outcome found",
		);
	}
}

/** Every scenario contributes a fixed number of checks; a short list means checks were skipped. */
const EXPECTED_CHECKS = {
	"composed-allow": 3 + 4 + 1 + 1 + 2,
	"composed-deny-write": 3 + 4 + 1 + 1 + 2 + 1,
	"composed-negative-control": 3 + 2 + 2,
	"composed-cancel-write": 3 + 4 + 1 + 1 + 2,
	"composed-parallel-allow": 3 + 2 + 2 + 1 + 2,
	"composed-parallel-deny-b": 3 + 2 + 2 + 1 + 2 + 1,
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function versions() {
	let piVersion;
	let piPath;
	try {
		piVersion = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
		piPath = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
	} catch (err) {
		throw new Error(`capture: cannot run the real pi CLI: ${err instanceof Error ? err.message : String(err)}`);
	}
	// Read the carrier's identity from the package it was loaded out of, so an overridden
	// carrier cannot be recorded under the pinned one's version.
	const carrier = JSON.parse(readFileSync(resolve(dirname(CARRIER), "..", "package.json"), "utf8"));
	let pigovCommit;
	try {
		pigovCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
	} catch {
		pigovCommit = "(not a git checkout)";
	}
	return {
		capturedAt: new Date().toISOString(),
		pi: piVersion,
		piPath,
		carrier: `${carrier.name}@${carrier.version}`,
		extension: EXTENSION,
		piGovernanceCommit: pigovCommit,
		shim: SHIM ?? "(none: pi-acp spawns gate-pi.mjs directly)",
		node: process.version,
		platform: `${process.platform} ${process.arch}`,
	};
}

function fail(message) {
	verdictReached = true;
	process.stderr.write(`\nCAPTURE FAILED: ${message}\n`);
	process.exit(1);
}

let verdictReached = false;
process.on("exit", (code) => {
	if (verdictReached) return;
	process.stderr.write("\nCAPTURE FAILED: harness exited without reaching a verdict\n");
	if (code === 0) process.exitCode = 2;
});

async function main() {
	const outIndex = process.argv.indexOf("--out");
	const outDir = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : join(REPO, "evidence", "latest");
	mkdirSync(outDir, { recursive: true });
	const onlyIndex = process.argv.indexOf("--only");
	const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;
	const selected = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
	if (selected.length === 0) fail(`--only ${only} matched no scenario`);

	for (const path of [CARRIER, SHIM, GATE_PI, EXTENSION, SEQ_PROVIDER, PAR_PROVIDER]) {
		// SHIM is optional; every other component is not, and a missing one fails the run
		// rather than quietly capturing a different stack.
		if (path !== null && !existsSync(path)) fail(`missing composed-path component: ${path}`);
	}
	const meta = versions();
	if (!meta.pi.startsWith("0.")) fail(`unexpected pi version string: ${meta.pi}`);

	const checks = [];
	const runs = [];
	for (const scenario of selected) {
		process.stderr.write(`capture: ${scenario.name}\n`);
		const run = await runScenario(scenario, outDir);
		runs.push(run);
		if (run.records.length === 0) fail(`${scenario.name} recorded ZERO wire records — see ${run.stderrPath}`);
		assertScenario(run, checks);
	}

	if (runs.length !== selected.length) fail(`ran ${runs.length} scenarios, expected ${selected.length}`);
	for (const scenario of selected) {
		const actual = checks.filter((c) => c.scenario === scenario.name).length;
		const expected = EXPECTED_CHECKS[scenario.name];
		if (actual !== expected) fail(`${scenario.name} produced ${actual} checks, expected ${expected}`);
	}
	if (checks.length === 0) fail("no assertions ran");

	const summary = {
		...meta,
		checks,
		scenarios: runs.map((r) => ({
			name: r.scenario.name,
			stopReason: r.stopReason,
			error: r.error ?? null,
			records: r.records.length,
			maxInFlightPermissions: r.maxInFlight,
			permissionRequests: r.permissions,
			undecodable: r.undecodable,
			piArgv: r.piArgv,
			disk: r.disk,
		})),
	};
	writeFileSync(join(outDir, only ? `summary-${only}.json` : "summary.json"), `${JSON.stringify(summary, null, "\t")}\n`);

	const lines = checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.scenario}  ${c.id}  ${c.detail}`);
	process.stdout.write(`${lines.join("\n")}\n`);
	const failed = checks.filter((c) => !c.ok);
	process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
	process.stdout.write(`evidence: ${outDir}\n`);
	verdictReached = true;
	if (failed.length > 0) fail(`${failed.length} admission check(s) failed`);
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
