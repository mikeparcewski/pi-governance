#!/usr/bin/env node
/**
 * `pi-governance` — the ACP agent binary. Speaks ACP to the host on stdio, runs the real
 * `pi` CLI in RPC mode underneath with the governance extension loaded.
 *
 *   pi-governance [--pi <bin>] [--negative-control] [-- <extra pi args>]
 *
 * Extra args after `--` are passed to pi verbatim (`--provider`, `--model`, `--tools`, ...).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import {
	AgentSideConnection,
	type Agent,
	type AuthenticateRequest,
	type CancelNotification,
	type InitializeRequest,
	type InitializeResponse,
	type NewSessionRequest,
	type NewSessionResponse,
	type PromptRequest,
	type PromptResponse,
	PROTOCOL_VERSION,
	ndJsonStream,
} from "@zed-industries/agent-client-protocol";
import { PiSession } from "./acp-agent.js";

const here = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH = join(here, "extension.js");
export const VERSION = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version as string;

interface Options {
	piBin: string;
	governed: boolean;
	piArgs: string[];
}

export function parseArgs(argv: string[]): Options {
	const options: Options = { piBin: "pi", governed: true, piArgs: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			options.piArgs.push(...argv.slice(i + 1));
			break;
		} else if (arg === "--pi") {
			options.piBin = argv[++i];
		} else if (arg === "--negative-control") {
			options.governed = false;
		} else {
			throw new Error(`pi-governance: unknown argument ${arg}`);
		}
	}
	return options;
}

class PiGovernanceAgent implements Agent {
	#sessions = new Map<string, PiSession>();
	#nextId = 0;

	constructor(
		private readonly conn: AgentSideConnection,
		private readonly options: Options,
	) {}

	async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
			authMethods: [],
		};
	}

	async authenticate(_params: AuthenticateRequest): Promise<void> {
		// pi owns its own provider credentials; there is nothing for the host to authenticate.
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		const sessionId = `pigov-${++this.#nextId}-${Date.now()}`;
		const piArgs = [...this.options.piArgs];
		if (this.options.governed) piArgs.push("-e", EXTENSION_PATH);
		const session = new PiSession({
			sessionId,
			cwd: resolve(params.cwd),
			piBin: this.options.piBin,
			piArgs,
			governed: this.options.governed,
			conn: this.conn,
		});
		this.#sessions.set(sessionId, session);
		return { sessionId };
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const session = this.#sessions.get(params.sessionId);
		if (!session) throw new Error(`unknown session ${params.sessionId}`);
		return await session.prompt(params);
	}

	async cancel(params: CancelNotification): Promise<void> {
		this.#sessions.get(params.sessionId)?.cancel();
	}
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	if (!options.governed) {
		process.stderr.write(
			"pi-governance: NEGATIVE CONTROL — the governance extension is NOT loaded. " +
				"Tool calls run without a permission round-trip. Never use this outside a capture.\n",
		);
	}
	const stream = ndJsonStream(
		Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
		Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
	);
	new AgentSideConnection((conn) => new PiGovernanceAgent(conn, options), stream);
}

main();
