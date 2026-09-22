/**
 * Capture-only pi extension: registers a local Ollama server as a pi provider.
 *
 * Used by capture/real-model.mjs so the boundary can be exercised by a real model making
 * its own tool-call decisions, with no hosted credential in play. Nothing here is part of
 * the shipped adapter.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MODEL = process.env.PIGOV_OLLAMA_MODEL ?? "llama3.2:3b";
const BASE_URL = process.env.PIGOV_OLLAMA_URL ?? "http://localhost:11434/v1";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("ollama", {
		name: "Ollama (local)",
		baseUrl: BASE_URL,
		apiKey: "ollama",
		api: "openai-completions",
		models: [
			{
				id: MODEL,
				name: MODEL,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131_072,
				maxTokens: 4096,
			},
		],
	} as never);
}
