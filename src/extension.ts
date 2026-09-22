/**
 * pi-governance extension.
 *
 * Every tool call pi makes is suspended here until the host answers. pi awaits this hook
 * before it prepares or executes the tool (pi-agent-core `prepareToolCall`), and a thrown
 * handler blocks execution, so this is the authoritative place to hold the boundary.
 *
 * The hook is deliberately the whole extension: no allowlist, no "always" answers, no
 * fast path. Every call asks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ALLOW_OPTION_ID,
	encodeEnvelope,
	PERMISSION_OPTIONS,
	type PermissionEnvelope,
	toolKind,
	toolTitle,
} from "./protocol.js";

const OPTION_IDS = PERMISSION_OPTIONS.map((option) => option.optionId);

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;

		// No channel to ask on means no boundary. Block rather than run ungoverned.
		if (!ctx.hasUI) {
			return { block: true, reason: "pi-governance: no host channel to request permission on" };
		}

		const envelope: PermissionEnvelope = {
			v: 1,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			kind: toolKind(event.toolName),
			title: toolTitle(event.toolName, input),
			rawInput: input,
			options: PERMISSION_OPTIONS,
		};

		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(encodeEnvelope(envelope), OPTION_IDS);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { block: true, reason: `pi-governance: permission request failed (${message})` };
		}

		// Anything that is not an explicit allow is a denial, including a cancelled or
		// dropped dialog, a host that answered with an unknown option id, and a host that
		// is not running this adapter at all.
		if (choice !== ALLOW_OPTION_ID) {
			return {
				block: true,
				reason: `pi-governance: ${event.toolName} denied by host (${choice ?? "no answer"})`,
			};
		}

		return undefined;
	});
}
