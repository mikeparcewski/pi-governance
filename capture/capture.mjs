#!/usr/bin/env node
/**
 * The admission capture.
 *
 * Runs the real `pi` CLI under the real adapter over a real ACP stdio connection, records
 * every JSON-RPC line in both directions, and then judges the recording against the four
 * admission points in the README. Disk state is read back from disk — never inferred from
 * the absence of a log line.
 *
 * It is built to fail loudly. An empty or short recording, a missing scenario, a crashed
 * child, or an assertion count that does not match the expected count all exit non-zero.
 * "No output" must never read like "all checks passed".
 *
 *   node capture/capture.mjs [--out <dir>]
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ClientSideConnection, ndJsonStream } from "@zed-industries/agent-client-protocol";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const ADAPTER = join(REPO, "dist", "cli.js");
const SCRIPTED_PROVIDER = join(HERE, "scripted-provider.ts");
const ALLOW = "allow-once";
const REJECT = "reject-once";
const SEED = "ORIGINAL line under governance\n";
const PROMPT = "Read target.txt, run echo, edit target.txt, then write written.txt.";
const TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

const SCENARIOS = [
	{
		name: "governed-allow",
		governed: true,
		decide: () => ALLOW,
		expect: { read: "EDITED line under governance\n", written: "CANARY-WRITE\n" },
	},
	{
		name: "governed-deny-write",
		governed: true,
		decide: (toolName) => (toolName === "write" ? REJECT : ALLOW),
		expect: { read: "EDITED line under governance\n", written: null },
	},
	{
		name: "negative-control-no-extension",
		governed: false,
		decide: () => ALLOW,
		expect: { read: "EDITED line under governance\n", written: "CANARY-WRITE\n" },
	},
];

// ---------------------------------------------------------------------------
// one scenario run
// ---------------------------------------------------------------------------

async function runScenario(scenario, outDir) {
	const workDir = join(outDir, scenario.name, "work");
	rmSync(join(outDir, scenario.name), { recursive: true, force: true });
	mkdirSync(workDir, { recursive: true });
	writeFileSync(join(workDir, "target.txt"), SEED);

	const wirePath = join(outDir, scenario.name, "wire.jsonl");
	writeFileSync(wirePath, "");
	const stderrPath = join(outDir, scenario.name, "stderr.log");
	writeFileSync(stderrPath, "");

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

	const args = [ADAPTER];
	if (!scenario.governed) args.push("--negative-control");
	args.push(
		"--",
		"--no-session",
		"--no-extensions",
		"--no-context-files",
		"-e",
		SCRIPTED_PROVIDER,
		"--provider",
		"pigov-capture",
		"--model",
		"pigov-capture/scripted",
	);

	const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
	child.stderr.on("data", (chunk) => appendFileSync(stderrPath, chunk.toString("utf8")));

	// Tee both directions at the byte level so the evidence is the wire, not our summary.
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
	const updates = [];
	const client = {
		async requestPermission(params) {
			const toolName = params.toolCall?._meta?.["pi-governance/toolName"] ?? "(unknown)";
			const optionId = scenario.decide(toolName);
			permissions.push({ toolName, toolCallId: params.toolCall?.toolCallId, optionId });
			return { outcome: { outcome: "selected", optionId } };
		},
		async sessionUpdate(params) {
			updates.push(params.update);
		},
		async writeTextFile() {
			throw new Error("fs/write_text_file not offered by this capture host");
		},
		async readTextFile() {
			throw new Error("fs/read_text_file not offered by this capture host");
		},
	};

	const connection = new ClientSideConnection(() => client, ndJsonStream(writable, readable));

	// A dead or silent adapter must surface as an error, not as a promise that never settles.
	// Waiting forever and then exiting quietly is the failure this harness exists to prevent.
	let timeout;
	const aborted = new Promise((_, reject) => {
		child.on("exit", (code, signal) =>
			reject(new Error(`adapter exited before the turn finished (code=${code} signal=${signal})`)),
		);
		timeout = setTimeout(() => {
			appendFileSync(stderrPath, "\ncapture: TIMEOUT\n");
			child.kill("SIGKILL");
			reject(new Error(`scenario timed out after ${TIMEOUT_MS}ms`));
		}, TIMEOUT_MS);
	});
	aborted.catch(() => {}); // the expected rejection after a clean run must not go unhandled

	const turn = async () => {
		await connection.initialize({
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
		});
		const session = await connection.newSession({ cwd: workDir, mcpServers: [] });
		return await connection.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: PROMPT }],
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

	const readBack = (name) => {
		const path = join(workDir, name);
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	};

	return {
		scenario,
		records,
		permissions,
		updates,
		stopReason,
		error,
		wirePath,
		stderrPath,
		stderr: existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "",
		disk: { "target.txt": readBack("target.txt"), "written.txt": readBack("written.txt") },
	};
}

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------

function indexOfPermissionRequest(records, toolCallId) {
	return records.findIndex(
		(r) =>
			r.direction === "agent->host" &&
			r.msg?.method === "session/request_permission" &&
			r.msg?.params?.toolCall?.toolCallId === toolCallId,
	);
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

function toolCallIdsByName(records) {
	const byName = new Map();
	for (const r of records) {
		const update = r.msg?.params?.update;
		if (r.direction !== "agent->host" || r.msg?.method !== "session/update") continue;
		if (update?.sessionUpdate !== "tool_call") continue;
		const toolName = update?._meta?.["pi-governance/toolName"];
		if (!toolName) continue;
		byName.set(toolName, update.toolCallId);
	}
	return byName;
}

function assertScenario(run, checks) {
	const { scenario, records } = run;
	const push = (id, ok, detail) => checks.push({ scenario: scenario.name, id, ok, detail });

	// Guard first: an empty or truncated recording must never read as a pass.
	const requests = records.filter((r) => r.msg?.method);
	push(
		"capture-is-non-empty",
		records.length >= 8 && requests.length >= 4,
		`records=${records.length} methods=${requests.length}`,
	);
	push("prompt-completed", run.error === undefined && run.stopReason === "end_turn", `stopReason=${run.stopReason} error=${run.error ?? "none"}`);

	const ids = toolCallIdsByName(records);
	const permissionRequests = records.filter(
		(r) => r.direction === "agent->host" && r.msg?.method === "session/request_permission",
	);

	if (scenario.governed) {
		// Admission 1: every tool kind asks before it runs.
		for (const toolName of ["read", "bash", "edit", "write"]) {
			const toolCallId = ids.get(toolName);
			if (!toolCallId) {
				push(`${toolName}-requests-permission`, false, "tool call never appeared on the wire");
				continue;
			}
			const requestIndex = indexOfPermissionRequest(records, toolCallId);
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

		// The adapter shouts when a tool completes with no permission outcome on record.
		const ungoverned = (run.stderr.match(/UNGOVERNED TOOL CALL/g) ?? []).length;
		push("no-ungoverned-tool-calls", ungoverned === 0, `adapter reported ${ungoverned}`);

		// Admission 2: the write cannot reach in_progress without an answered request.
		const writeId = ids.get("write");
		const writeRequest = writeId ? indexOfPermissionRequest(records, writeId) : -1;
		const writeAnswer = writeRequest >= 0 ? indexOfPermissionResponse(records, writeRequest) : -1;
		const writeInProgress = writeId ? toolUpdateIndexes(records, writeId, "in_progress") : [];
		push(
			"write-in-progress-only-after-permission-response",
			writeRequest >= 0 && writeAnswer > writeRequest && writeInProgress.every((index) => index > writeAnswer),
			`request@${writeRequest} answer@${writeAnswer} in_progress@[${writeInProgress.join(",")}]`,
		);
	} else {
		// Negative control: no boundary at all.
		push("negative-control-zero-permission-requests", permissionRequests.length === 0, `requests=${permissionRequests.length}`);
		const writeId = ids.get("write");
		push(
			"negative-control-write-executed",
			writeId !== undefined && toolUpdateIndexes(records, writeId, "completed").length === 1,
			`writeToolCallId=${writeId}`,
		);
	}

	// Admission 3 and its negative: judged on disk, not on the log.
	push(
		"disk-target.txt",
		run.disk["target.txt"] === scenario.expect.read,
		`on disk: ${JSON.stringify(run.disk["target.txt"])}`,
	);
	push(
		"disk-written.txt",
		run.disk["written.txt"] === scenario.expect.written,
		`on disk: ${JSON.stringify(run.disk["written.txt"])}`,
	);

	if (scenario.name === "governed-deny-write") {
		const denial = records.find(
			(r) =>
				r.direction === "host->agent" &&
				r.msg?.result?.outcome?.outcome === "selected" &&
				r.msg?.result?.outcome?.optionId === REJECT,
		);
		push("denial-visible-on-the-wire", denial !== undefined, denial ? `record seq=${denial.seq}` : "no reject outcome found");
	}
}

/** Every scenario contributes a fixed number of checks; a short list means checks were skipped. */
const EXPECTED_CHECKS = {
	"governed-allow": 2 + 4 + 1 + 1 + 2,
	"governed-deny-write": 2 + 4 + 1 + 1 + 2 + 1,
	"negative-control-no-extension": 2 + 2 + 2,
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function versions() {
	const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
	let piVersion;
	let piPath;
	try {
		piVersion = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
		piPath = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
	} catch (err) {
		throw new Error(`capture: cannot run the real pi CLI: ${err instanceof Error ? err.message : String(err)}`);
	}
	let commit;
	try {
		commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
	} catch {
		commit = "(not a git checkout)";
	}
	return {
		capturedAt: new Date().toISOString(),
		pi: piVersion,
		piPath,
		piGovernance: pkg.version,
		piGovernanceCommit: commit,
		acpLibrary: pkg.dependencies["@zed-industries/agent-client-protocol"],
		node: process.version,
		platform: `${process.platform} ${process.arch}`,
	};
}

function fail(message) {
	verdictReached = true; // a stated failure is a verdict
	process.stderr.write(`\nCAPTURE FAILED: ${message}\n`);
	process.exit(1);
}

/**
 * Last line of defence against a silent pass: if this process ends without the harness
 * having reached a verdict — a swallowed error, a stream that never closed, an early
 * return — say so and exit non-zero.
 */
let verdictReached = false;
process.on("exit", (code) => {
	if (verdictReached) return;
	process.stderr.write("\nCAPTURE FAILED: harness exited without reaching a verdict\n");
	if (code === 0) process.exitCode = 2;
});

async function main() {
	const outIndex = process.argv.indexOf("--out");
	const stamp = new Date().toISOString().slice(0, 10);
	const outDir = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : join(REPO, "evidence", stamp);
	mkdirSync(outDir, { recursive: true });

	if (!existsSync(ADAPTER)) fail(`adapter not built: ${ADAPTER} (run npm run build)`);
	const meta = versions();
	if (!meta.pi.startsWith("0.")) fail(`unexpected pi version string: ${meta.pi}`);

	const checks = [];
	const runs = [];
	for (const scenario of SCENARIOS) {
		process.stderr.write(`capture: ${scenario.name}\n`);
		const run = await runScenario(scenario, outDir);
		runs.push(run);
		if (run.records.length === 0) {
			fail(`${scenario.name} recorded ZERO wire records — see ${run.stderrPath}`);
		}
		assertScenario(run, checks);
	}

	// A silent pass is the failure mode this harness exists to prevent.
	if (runs.length !== SCENARIOS.length) fail(`ran ${runs.length} scenarios, expected ${SCENARIOS.length}`);
	for (const scenario of SCENARIOS) {
		const actual = checks.filter((c) => c.scenario === scenario.name).length;
		const expected = EXPECTED_CHECKS[scenario.name];
		if (actual !== expected) fail(`${scenario.name} produced ${actual} checks, expected ${expected}`);
	}
	if (checks.length === 0) fail("no assertions ran");

	const summary = { ...meta, checks, scenarios: runs.map((r) => ({ name: r.scenario.name, stopReason: r.stopReason, error: r.error ?? null, wire: r.wirePath.slice(REPO.length + 1), records: r.records.length, permissionRequests: r.permissions, disk: r.disk })) };
	writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, "\t")}\n`);

	const lines = [];
	for (const check of checks) {
		lines.push(`${check.ok ? "PASS" : "FAIL"}  ${check.scenario}  ${check.id}  ${check.detail}`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	const failed = checks.filter((c) => !c.ok);
	process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
	process.stdout.write(`evidence: ${outDir}\n`);
	verdictReached = true;
	if (failed.length > 0) fail(`${failed.length} admission check(s) failed`);
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
