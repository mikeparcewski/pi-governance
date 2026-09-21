/**
 * The ACP agent: one pi process per session, every tool call held at the boundary.
 *
 * Ordering is the whole point, so it is worth stating plainly. pi emits
 * `tool_execution_start` *before* it runs the `tool_call` hook (pi-agent-core
 * `executeToolCalls` emits, then `prepareToolCall` awaits the hook), so that event means
 * "pi intends to run this", not "pi is running this". This adapter therefore maps it to ACP
 * status `pending`, issues `session/request_permission`, and only reports `in_progress`
 * after an allow comes back. A tool call that reaches `in_progress` in a capture has, by
 * construction, already been answered on the wire.
 */

import type {
	AgentSideConnection,
	ContentBlock,
	PromptRequest,
	PromptResponse,
	SessionNotification,
	ToolCallContent,
} from "@zed-industries/agent-client-protocol";
import { type PiRecord, PiRpc, isUiRequest } from "./pi-rpc.js";
import { ALLOW_OPTION_ID, decodeEnvelope, REJECT_OPTION_ID, toolKind, toolTitle } from "./protocol.js";

export interface SessionOptions {
	sessionId: string;
	cwd: string;
	piBin: string;
	piArgs: string[];
	/** False only for the negative control: pi runs without the extension, nothing is asked. */
	governed: boolean;
	conn: AgentSideConnection;
}

type PermissionState = "allowed" | "denied";

export class PiSession {
	readonly sessionId: string;
	readonly #conn: AgentSideConnection;
	readonly #pi: PiRpc;
	readonly #governed: boolean;
	readonly #permissions = new Map<string, PermissionState>();
	readonly #seen = new Map<string, { toolName: string }>();
	#pendingPrompt: { resolve: (r: PromptResponse) => void; reject: (e: Error) => void } | undefined;
	#cancelled = false;
	#exited = false;

	constructor(options: SessionOptions) {
		this.sessionId = options.sessionId;
		this.#conn = options.conn;
		this.#governed = options.governed;
		this.#pi = new PiRpc({
			piBin: options.piBin,
			cwd: options.cwd,
			args: options.piArgs,
			onRecord: (record) => {
				void this.#onRecord(record).catch((err) => {
					process.stderr.write(`pi-governance: record handling failed: ${String(err)}\n`);
				});
			},
			onStderr: (chunk) => process.stderr.write(`[pi] ${chunk}`),
			onExit: (code, signal) => {
				this.#exited = true;
				this.#pendingPrompt?.reject(new Error(`pi exited (code=${code} signal=${signal})`));
				this.#pendingPrompt = undefined;
			},
		});
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		if (this.#exited) throw new Error("pi process is not running");
		this.#cancelled = false;
		const text = params.prompt
			.map((block: ContentBlock) => (block.type === "text" ? block.text : ""))
			.join("")
			.trim();

		return await new Promise<PromptResponse>((resolve, reject) => {
			this.#pendingPrompt = { resolve, reject };
			this.#pi.send({ id: `prompt-${Date.now()}`, type: "prompt", message: text });
		});
	}

	cancel(): void {
		this.#cancelled = true;
		this.#pi.send({ type: "abort" });
	}

	kill(): void {
		this.#pi.kill();
	}

	async #onRecord(record: PiRecord): Promise<void> {
		if (isUiRequest(record)) {
			await this.#onUiRequest(record);
			return;
		}

		switch (record.type) {
			case "message_update":
				await this.#onMessageUpdate(record);
				return;
			case "tool_execution_start":
				await this.#onToolStart(record);
				return;
			case "tool_execution_end":
				await this.#onToolEnd(record);
				return;
			case "agent_settled": {
				const pending = this.#pendingPrompt;
				this.#pendingPrompt = undefined;
				pending?.resolve({ stopReason: this.#cancelled ? "cancelled" : "end_turn" });
				return;
			}
			case "response":
				if (record.command === "prompt" && record.success === false) {
					const pending = this.#pendingPrompt;
					this.#pendingPrompt = undefined;
					pending?.reject(new Error(String(record.error ?? "pi rejected the prompt")));
				}
				return;
			default:
				return;
		}
	}

	async #onMessageUpdate(record: PiRecord): Promise<void> {
		const event = record.assistantMessageEvent as { type?: string; delta?: string } | undefined;
		if (!event?.delta) return;
		if (event.type === "text_delta") {
			await this.#update({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: event.delta },
			});
		} else if (event.type === "thinking_delta") {
			await this.#update({
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: event.delta },
			});
		}
	}

	/**
	 * pi intends to run a tool. Governed: report it as pending and wait for the extension's
	 * permission request. Ungoverned (negative control only): report in_progress straight
	 * away, which is what an adapter without a boundary does.
	 */
	async #onToolStart(record: PiRecord): Promise<void> {
		const toolCallId = String(record.toolCallId);
		const toolName = String(record.toolName);
		this.#seen.set(toolCallId, { toolName });
		const input = (record.args ?? {}) as Record<string, unknown>;
		await this.#update({
			sessionUpdate: "tool_call",
			toolCallId,
			title: toolTitle(toolName, input),
			kind: toolKind(toolName),
			status: this.#governed ? "pending" : "in_progress",
			rawInput: input,
			_meta: { "pi-governance/toolName": toolName },
		});
	}

	async #onToolEnd(record: PiRecord): Promise<void> {
		const toolCallId = String(record.toolCallId);
		const isError = record.isError === true;
		const result = record.result as { content?: Array<{ type: string; text?: string }> } | undefined;
		const content: ToolCallContent[] = (result?.content ?? [])
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => ({ type: "content", content: { type: "text", text: part.text as string } }));

		const decision = this.#permissions.get(toolCallId);
		if (this.#governed && decision === undefined) {
			// A tool ran without ever reaching the boundary. Say so loudly and mark the wire.
			process.stderr.write(
				`pi-governance: UNGOVERNED TOOL CALL ${toolCallId} (${this.#seen.get(toolCallId)?.toolName}) ` +
					"completed without a permission round-trip\n",
			);
			await this.#update({
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: isError ? "failed" : "completed",
				content,
				_meta: { "pi-governance/ungoverned": true },
			});
			return;
		}

		await this.#update({
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: isError ? "failed" : "completed",
			content,
		});
	}

	async #onUiRequest(record: PiRecord & { id: string; method: string }): Promise<void> {
		const envelope = record.method === "select" ? decodeEnvelope(record.title as string) : undefined;

		if (!envelope) {
			// Not a permission request. Fire-and-forget methods need no answer; any other
			// dialog is dismissed, because ACP has no surface for arbitrary agent-side UI.
			if (record.method === "select" || record.method === "confirm" || record.method === "input" || record.method === "editor") {
				process.stderr.write(`pi-governance: dismissing non-permission ${record.method} dialog\n`);
				this.#pi.answerUi({ type: "extension_ui_response", id: record.id, cancelled: true });
			}
			return;
		}

		let optionId: string | undefined;
		try {
			const response = await this.#conn.requestPermission({
				sessionId: this.sessionId,
				toolCall: {
					toolCallId: envelope.toolCallId,
					title: envelope.title,
					kind: envelope.kind,
					status: "pending",
					rawInput: envelope.rawInput,
					_meta: { "pi-governance/toolName": envelope.toolName },
				},
				options: envelope.options,
			});
			optionId = response.outcome.outcome === "selected" ? response.outcome.optionId : undefined;
		} catch (err) {
			process.stderr.write(`pi-governance: permission request failed: ${String(err)}\n`);
			optionId = undefined;
		}

		const allowed = optionId === ALLOW_OPTION_ID;
		this.#permissions.set(envelope.toolCallId, allowed ? "allowed" : "denied");
		this.#pi.answerUi({
			type: "extension_ui_response",
			id: record.id,
			value: optionId ?? REJECT_OPTION_ID,
		});

		if (allowed) {
			await this.#update({
				sessionUpdate: "tool_call_update",
				toolCallId: envelope.toolCallId,
				status: "in_progress",
			});
		}
	}

	async #update(update: SessionNotification["update"]): Promise<void> {
		await this.#conn.sessionUpdate({ sessionId: this.sessionId, update });
	}
}
