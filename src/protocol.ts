/**
 * The envelope carried between the pi extension and the ACP adapter.
 *
 * pi's RPC mode turns `ctx.ui.select(title, options)` inside a `tool_call` hook into an
 * `extension_ui_request` on stdout that blocks until the client answers on stdin
 * (docs/rpc.md, "Extension UI Protocol"). That blocking round-trip is the only channel an
 * extension has to the process that embeds pi, so it is the channel the permission request
 * rides on: the title carries a tagged JSON envelope, the options carry the ACP option ids.
 *
 * Everything here is shared by both sides so the two cannot drift.
 */

/** Tag that identifies a select request as a pi-governance permission request. */
export const ENVELOPE_TAG = "pi-governance/1";

/** ACP `ToolKind` values this adapter emits. */
export type ToolKind = "read" | "edit" | "execute" | "search" | "fetch" | "other";

export interface EnvelopeOption {
	optionId: string;
	name: string;
	kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PermissionEnvelope {
	v: 1;
	toolCallId: string;
	toolName: string;
	kind: ToolKind;
	title: string;
	rawInput: Record<string, unknown>;
	options: EnvelopeOption[];
}

/**
 * Only once-scoped options are offered. "Always" answers would let a later tool call execute
 * without a round-trip, and a boundary that is sometimes silent cannot be audited from a capture.
 */
export const ALLOW_OPTION_ID = "allow-once";
export const REJECT_OPTION_ID = "reject-once";

export const PERMISSION_OPTIONS: EnvelopeOption[] = [
	{ optionId: ALLOW_OPTION_ID, name: "Allow once", kind: "allow_once" },
	{ optionId: REJECT_OPTION_ID, name: "Reject once", kind: "reject_once" },
];

export function encodeEnvelope(envelope: PermissionEnvelope): string {
	return `${ENVELOPE_TAG} ${JSON.stringify(envelope)}`;
}

/** Returns the envelope, or undefined when this select came from some other extension. */
export function decodeEnvelope(title: string | undefined): PermissionEnvelope | undefined {
	if (!title || !title.startsWith(`${ENVELOPE_TAG} `)) return undefined;
	try {
		const parsed = JSON.parse(title.slice(ENVELOPE_TAG.length + 1)) as PermissionEnvelope;
		if (parsed?.v !== 1 || typeof parsed.toolCallId !== "string") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/** pi tool name -> ACP tool kind. Unknown tools are "other" and are still governed. */
export function toolKind(toolName: string): ToolKind {
	switch (toolName) {
		case "read":
		case "ls":
			return "read";
		case "edit":
		case "write":
			return "edit";
		case "bash":
			return "execute";
		case "grep":
		case "find":
			return "search";
		default:
			return "other";
	}
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/** A one-line human-readable summary of the call, for the host's permission prompt. */
export function toolTitle(toolName: string, input: Record<string, unknown>): string {
	const subject = firstString(input, ["path", "file_path", "command", "pattern", "url"]);
	if (!subject) return toolName;
	const trimmed = subject.length > 120 ? `${subject.slice(0, 117)}...` : subject;
	return `${toolName}: ${trimmed}`;
}
