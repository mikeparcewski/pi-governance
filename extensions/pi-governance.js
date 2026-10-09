/**
 * pi-governance: every pi tool call becomes a permission request to the host before it runs.
 *
 * The seam is pi's own `tool_call` hook. pi awaits it before a tool executes, and a
 * `{ block: true }` result means the tool never runs. The question goes out through
 * `ctx.ui.confirm`. Under `pi --mode rpc` that is an `extension_ui_request` that resolves only on
 * the client's answer. The ACP adapter (pi-acp) turns it into a real `session/request_permission`
 * round-trip, so the ACP host answers every call.
 *
 * Rules (each one is a way the defect this replaces could come back):
 * - Every tool asks. No tool is treated as safe by name: under a scoped repository a `read` is a
 *   boundary question too.
 * - Anything other than an explicit yes is a deny: a cancel, a timeout, a thrown dialog, or a
 *   mode with no permission channel (`-p`, `--mode json`).
 * - The request carries the canonical tool name and the tool's real arguments, in a versioned
 *   envelope (see `envelope`), so the host can judge paths and commands rather than prose.
 */

/** The envelope's marker key. Its value is the envelope version. */
export const ENVELOPE_KEY = 'pi-governance';
export const ENVELOPE_VERSION = 1;

/**
 * The permission question for one tool call.
 *
 * `title` is the bare canonical tool name (`write`, `edit`, `bash`, `read`, ...). A host that
 * understands only the title still classifies the call by name. `message` is the JSON envelope
 * with the tool's own arguments under `input`. pi-acp copies `title` and `message` into the
 * request's `toolCall.rawInput`.
 *
 * @param {{ toolName: string, toolCallId?: string, input?: unknown }} event
 * @returns {{ title: string, message: string }}
 */
export function envelope(event) {
  const toolName = String(event?.toolName ?? '');
  const body = {
    [ENVELOPE_KEY]: ENVELOPE_VERSION,
    toolCallId: event?.toolCallId ?? null,
    toolName,
    input: event?.input ?? null,
  };
  return { title: toolName, message: JSON.stringify(body) };
}

/**
 * Decide one tool call. Returns `undefined` to let the call run, or pi's block result.
 *
 * @param {{ toolName: string, toolCallId?: string, input?: unknown }} event
 * @param {{ hasUI?: boolean, mode?: string, ui?: { confirm?: Function } }} ctx
 */
export async function decide(event, ctx) {
  const tool = String(event?.toolName ?? '(unnamed)');
  if (!ctx?.hasUI || typeof ctx?.ui?.confirm !== 'function') {
    return {
      block: true,
      reason: `pi-governance: no permission channel in mode '${ctx?.mode ?? 'unknown'}', so \`${tool}\` is denied`,
    };
  }
  const { title, message } = envelope(event);
  let answer;
  try {
    answer = await ctx.ui.confirm(title, message);
  } catch (err) {
    return {
      block: true,
      reason: `pi-governance: the permission request for \`${tool}\` failed (${err?.message ?? String(err)}), so it is denied`,
    };
  }
  if (answer === true) return undefined;
  return { block: true, reason: `pi-governance: the host did not allow \`${tool}\`` };
}

/** The pi extension factory. */
export default function piGovernance(pi) {
  pi.on('tool_call', (event, ctx) => decide(event, ctx));
}
