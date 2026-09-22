/**
 * Capture-only pi extension: a scripted model provider that emits TWO tool calls in ONE
 * assistant message.
 *
 * pi/docs/extensions.md:757 states sibling tool calls are preflighted sequentially and then
 * executed concurrently, so N permission asks arrive before N executions. This provider
 * constructs exactly that: two `write` calls to DIFFERENT paths, so neither ask can be matched
 * to the right call by tool kind alone — only by id.
 *
 * Derived from pi-governance's capture/scripted-provider.ts. Nothing about the boundary under
 * test is simulated: pi, its tools and the disk writes are real.
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

/** Turn 0 emits both of these in a single assistant message. */
const PARALLEL: Array<{ name: string; args: Record<string, unknown> }> = [
	{ name: "write", args: { path: "parallel-a.txt", content: "A-CONTENT\n" } },
	{ name: "write", args: { path: "parallel-b.txt", content: "B-CONTENT\n" } },
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

		const turn = (context.messages ?? []).filter((message) => message.role === "assistant").length;

		if (turn === 0) {
			for (const step of PARALLEL) {
				const id = `scripted-par-${step.args.path}`;
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
			}
			output.stopReason = "toolUse";
		} else {
			const text = "scripted parallel capture complete";
			output.content.push({ type: "text", text: "" });
			const index = output.content.length - 1;
			stream.push({ type: "text_start", contentIndex: index, partial: output });
			(output.content[index] as { type: "text"; text: string }).text = text;
			stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
			stream.push({ type: "text_end", contentIndex: index, content: text, partial: output });
			output.stopReason = "stop";
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
			name: "pi-governance parallel capture script",
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
