/**
 * A minimal client for `pi --mode rpc`.
 *
 * Framing is strict JSONL with LF as the only delimiter; pi's docs call out that Node's
 * `readline` is not protocol-compliant here because it also splits on U+2028/U+2029, which
 * are legal inside JSON strings (docs/rpc.md, "Framing"). So the split is done by hand.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type {
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";

/** Anything pi writes on stdout: agent events, command responses, extension UI requests. */
export type PiRecord = { type: string; [key: string]: unknown };

export interface PiRpcOptions {
	piBin: string;
	cwd: string;
	args: string[];
	onRecord: (record: PiRecord) => void;
	onStderr?: (chunk: string) => void;
	onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class PiRpc {
	readonly child: ChildProcessWithoutNullStreams;
	#buffer = "";

	constructor(options: PiRpcOptions) {
		this.child = spawn(options.piBin, ["--mode", "rpc", ...options.args], {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;

		this.child.stdout.on("data", (chunk: Buffer) => {
			this.#buffer += chunk.toString("utf8");
			let index = this.#buffer.indexOf("\n");
			while (index >= 0) {
				const line = this.#buffer.slice(0, index).replace(/\r$/, "");
				this.#buffer = this.#buffer.slice(index + 1);
				if (line.trim().length > 0) {
					try {
						options.onRecord(JSON.parse(line) as PiRecord);
					} catch {
						options.onStderr?.(`pi-governance: unparseable pi record: ${line}\n`);
					}
				}
				index = this.#buffer.indexOf("\n");
			}
		});

		this.child.stderr.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8")));
		this.child.on("exit", (code, signal) => options.onExit?.(code, signal));
	}

	send(command: Record<string, unknown>): void {
		this.child.stdin.write(`${JSON.stringify(command)}\n`);
	}

	answerUi(response: RpcExtensionUIResponse): void {
		this.send(response as unknown as Record<string, unknown>);
	}

	kill(): void {
		this.child.stdin.end();
		this.child.kill();
	}
}

export function isUiRequest(record: PiRecord): record is RpcExtensionUIRequest & PiRecord {
	return record.type === "extension_ui_request" && typeof record.id === "string";
}
