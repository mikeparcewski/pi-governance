#!/usr/bin/env node
/**
 * Corroboration capture: the same composed stack, a real model instead of the scripted provider.
 *
 * capture/capture.mjs scripts the model so the four tool kinds appear in a fixed order.
 * That makes the run reproducible, but it also means the model in that capture is not
 * choosing anything. This run hands the wheel to a real model (a local Ollama server, so
 * no hosted credential is involved) and checks the two claims that matter: the tool call
 * is asked about before it runs, and a denial leaves the disk untouched.
 *
 * The carrier is `pi-acp`, exactly as in capture/capture.mjs — this file loads no adapter
 * of its own, only the gate extension.
 *
 *   ollama serve &
 *   ollama pull llama3.2:3b
 *   node capture/real-model.mjs [--out <dir>]
 *
 * A missing Ollama server exits non-zero. A precondition that is not met is not a pass.
 */

import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ClientSideConnection, ndJsonStream } from "@zed-industries/agent-client-protocol";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CARRIER = join(REPO, "node_modules", "pi-acp", "dist", "index.js");
const GATE_PI = join(HERE, "gate-pi.mjs");
const SHIM = process.env.PIGOV_PI_SHIM ? resolve(process.env.PIGOV_PI_SHIM) : null;
const EXTENSION = join(REPO, "dist", "extension.js");
const PROVIDER = join(HERE, "ollama-provider.ts");
const ENVELOPE_TAG = "pi-governance/1";
const MODEL = process.env.PIGOV_OLLAMA_MODEL ?? "llama3.2:3b";
const BASE_URL = process.env.PIGOV_OLLAMA_URL ?? "http://localhost:11434/v1";
const PROMPT =
	"Use the write tool with path hello.txt (a relative path in the current directory, no leading slash) and content exactly: CANARY";
const TIMEOUT_MS = 300_000;

function fail(message) {
	process.stderr.write(`\nREAL-MODEL CAPTURE FAILED: ${message}\n`);
	process.exit(1);
}

/** The host side of the envelope. pi-acp carries it in the synthetic tool call's title. */
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

async function run(mode, outDir) {
	// The option NAME the host answers with. pi-acp rewrites option ids to `choice-<index>`,
	// so the extension's own id survives only as the name — answer on that, as any host must.
	const wanted = mode === "deny" ? "reject-once" : "allow-once";
	const dir = join(outDir, `real-model-${mode}`);
	rmSync(dir, { recursive: true, force: true });
	const workDir = mkdtempSync(join(tmpdir(), `pi-governance-real-${mode}-`));
	mkdirSync(dir, { recursive: true });
	const wirePath = join(dir, "wire.jsonl");
	writeFileSync(wirePath, "");

	// Same composition as capture/capture.mjs: pi-acp is the carrier, gate-pi prepends the
	// gate flags, and `-ne` keeps extension discovery from shadowing the gate.
	const piFlags = [
		"--no-session",
		"--no-context-files",
		"-ne",
		"-e",
		EXTENSION,
		"-e",
		PROVIDER,
		"--provider",
		"ollama",
		"--model",
		`ollama/${MODEL}`,
	];
	const child = spawn(process.execPath, [CARRIER], {
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			PI_ACP_PI_COMMAND: SHIM ?? GATE_PI,
			WICKED_PI_BINARY: GATE_PI,
			PIPROOF_PI_FLAGS: JSON.stringify(piFlags),
			PIPROOF_ARGV_LOG: join(dir, "pi-argv.jsonl"),
			NO_COLOR: "1",
		},
	});
	child.stderr.on("data", (chunk) => appendFileSync(join(dir, "stderr.log"), chunk.toString("utf8")));

	const record = (direction, line) => {
		if (!line.trim()) return;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			msg = { unparseable: line };
		}
		appendFileSync(wirePath, `${JSON.stringify({ ts: new Date().toISOString(), direction, msg })}\n`);
	};
	const framed = (direction) => {
		let buffer = "";
		return (chunk) => {
			buffer += Buffer.from(chunk).toString("utf8");
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				record(direction, buffer.slice(0, index));
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
			}
		};
	};
	const logIn = framed("agent->host");
	const readable = Readable.toWeb(child.stdout).pipeThrough(
		new TransformStream({
			transform(chunk, controller) {
				logIn(chunk);
				controller.enqueue(chunk);
			},
		}),
	);
	const logOut = framed("host->agent");
	const writer = Writable.toWeb(child.stdin).getWriter();
	const writable = new WritableStream({
		async write(chunk) {
			logOut(chunk);
			await writer.write(chunk);
		},
	});

	const asks = [];
	const undecodable = [];
	const client = {
		async requestPermission(params) {
			const envelope = decodeEnvelope(params.toolCall?.title);
			if (!envelope) {
				// A permission request this host cannot understand is a failure, not a pass.
				undecodable.push(String(params.toolCall?.title).slice(0, 200));
				return { outcome: { outcome: "cancelled" } };
			}
			const option = (params.options ?? []).find((o) => o.name === wanted);
			asks.push({
				toolName: envelope.toolName,
				title: envelope.title,
				answer: wanted,
				answeredOptionId: option?.optionId ?? null,
				offered: (params.options ?? []).map((o) => `${o.optionId}:${o.name}:${o.kind}`),
			});
			if (!option) return { outcome: { outcome: "cancelled" } };
			return { outcome: { outcome: "selected", optionId: option.optionId } };
		},
		async sessionUpdate() {},
	};

	const connection = new ClientSideConnection(() => client, ndJsonStream(writable, readable));
	let timeout;
	const aborted = new Promise((_, reject) => {
		child.on("exit", (code, signal) => reject(new Error(`carrier exited early (code=${code} signal=${signal})`)));
		timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`timed out after ${TIMEOUT_MS}ms`));
		}, TIMEOUT_MS);
	});
	aborted.catch(() => {});

	let error;
	let stopReason;
	try {
		const turn = (async () => {
			await connection.initialize({
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
			});
			const session = await connection.newSession({ cwd: workDir, mcpServers: [] });
			return await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: PROMPT }] });
		})();
		stopReason = (await Promise.race([turn, aborted])).stopReason;
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		clearTimeout(timeout);
		child.kill();
	}

	const target = join(workDir, "hello.txt");
	const onDisk = existsSync(target) ? readFileSync(target, "utf8") : null;
	if (onDisk !== null) {
		mkdirSync(join(dir, "work"), { recursive: true });
		writeFileSync(join(dir, "work", "hello.txt"), onDisk);
	}
	rmSync(workDir, { recursive: true, force: true });
	return { mode, asks, undecodable, stopReason, error, onDisk };
}

async function main() {
	for (const path of [CARRIER, GATE_PI, EXTENSION, PROVIDER]) {
		if (!existsSync(path)) fail(`missing composed-path component: ${path} (npm ci && npm run build)`);
	}
	try {
		execFileSync("curl", ["-sf", "-m", "5", BASE_URL.replace(/\/v1$/, "/api/version")], { encoding: "utf8" });
	} catch {
		fail(`no Ollama server at ${BASE_URL} — start it with \`ollama serve\` and \`ollama pull ${MODEL}\``);
	}

	const outIndex = process.argv.indexOf("--out");
	const outDir = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : join(REPO, "evidence", new Date().toISOString().slice(0, 10));
	mkdirSync(outDir, { recursive: true });

	const checks = [];
	for (const mode of ["allow", "deny"]) {
		process.stderr.write(`real-model capture: ${mode}\n`);
		const result = await run(mode, outDir);
		const wroteTool = result.asks.filter((ask) => ask.toolName === "write").length;
		checks.push({ mode, id: "turn-completed", ok: result.error === undefined, detail: `stopReason=${result.stopReason} error=${result.error ?? "none"}` });
		checks.push({ mode, id: "write-was-asked-about", ok: wroteTool >= 1, detail: `write permission requests=${wroteTool}` });
		checks.push({
			mode,
			id: "no-undecodable-permission-requests",
			ok: result.undecodable.length === 0,
			detail: JSON.stringify(result.undecodable),
		});
		checks.push({
			mode,
			id: "disk-hello.txt",
			ok: mode === "allow" ? result.onDisk === "CANARY" : result.onDisk === null,
			detail: `on disk: ${JSON.stringify(result.onDisk)}`,
		});
		writeFileSync(join(outDir, `real-model-${mode}`, "result.json"), `${JSON.stringify({ model: MODEL, ...result }, null, "\t")}\n`);
	}

	if (checks.length !== 8) fail(`produced ${checks.length} checks, expected 8`);
	for (const check of checks) {
		process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  real-model-${check.mode}  ${check.id}  ${check.detail}\n`);
	}
	const failed = checks.filter((check) => !check.ok);
	process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed (model: ${MODEL})\n`);
	if (failed.length > 0) fail(`${failed.length} check(s) failed`);
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
