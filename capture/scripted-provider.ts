/**
 * Capture-only pi extension: a scripted model provider.
 *
 * The capture has to exercise read, bash, edit and write in a fixed order on every run, so
 * the model is scripted rather than sampled. Nothing else is simulated — pi is the real
 * 0.84.2 CLI, the tools are pi's real built-in tools, they really touch the disk, and the
 * permission boundary under test is untouched by this file.
 *
 * This is not part of the shipped adapter. It is loaded only by capture/capture.mjs.
 */

import {
	type AssistantMessage,
	type Context,
	type Model,
	calculateCost,
	createAssistantMessageEventStream,
	createProvider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STEPS: Array<{ name: string; args: Record<string, unknown> }> = [
	{ name: "read", args: { path: "target.txt" } },
	{ name: "bash", args: { command: "echo hello-from-bash" } },
	{ name: "edit", args: { path: "target.txt", edits: [{ oldText: "ORIGINAL", newText: "EDITED" }] } },
	{ name: "write", args: { path: "written.txt", content: "CANARY-WRITE\n" } },
];

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function streamScripted(model: Model<never>, context: Context) {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: output });

		// One step per assistant turn already in the context: strictly ordered, no sampling.
		const turn = (context.messages ?? []).filter((message) => message.role === "assistant").length;
		const step = STEPS[turn];

		if (!step) {
			const text = "scripted capture complete";
			output.content.push({ type: "text", text: "" });
			const index = output.content.length - 1;
			stream.push({ type: "text_start", contentIndex: index, partial: output });
			(output.content[index] as { type: "text"; text: string }).text = text;
			stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
			stream.push({ type: "text_end", contentIndex: index, content: text, partial: output });
			output.stopReason = "stop";
		} else {
			const id = `scripted-${turn}-${step.name}`;
			output.content.push({ type: "toolCall", id, name: step.name, arguments: step.args });
			const index = output.content.length - 1;
			stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
			stream.push({
				type: "toolcall_delta",
				contentIndex: index,
				delta: JSON.stringify(step.args),
				partial: output,
			});
			stream.push({
				type: "toolcall_end",
				contentIndex: index,
				toolCall: { type: "toolCall", id, name: step.name, arguments: step.args },
				partial: output,
			});
			output.stopReason = "toolUse";
		}

		calculateCost(model, output.usage);
		stream.push({ type: "done", reason: output.stopReason, message: output });
		stream.end();
	})();

	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(
		createProvider({
			id: "pigov-capture",
			name: "pi-governance capture script",
			baseUrl: "http://scripted.invalid",
			auth: {
				apiKey: {
					name: "none (scripted)",
					async resolve() {
						return { auth: { apiKey: "scripted" }, source: "scripted" };
					},
				},
			},
			models: [
				{
					id: "scripted",
					name: "scripted",
					api: "anthropic-messages",
					provider: "pigov-capture",
					baseUrl: "http://scripted.invalid",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 4096,
				},
			],
			api: { stream: streamScripted, streamSimple: streamScripted },
		} as never),
	);
}
