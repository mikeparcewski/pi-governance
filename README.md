# pi-governance

A governable ACP adapter for the [pi](https://github.com/possibilities/pi) CLI, shipped as a pi
extension.

**The name is the contract.** Every tool call pi makes — `read`, `edit`, `write`, `bash` — is
surfaced as a real ACP `session/request_permission` round-trip **before** it executes. This is not
a wrapper, a re-skin, or a transport that happens to carry tool calls. Its job is the boundary.

## Why this exists

A host that embeds pi through ACP can only enforce a boundary it can see. The community adapter
(`pi-acp`) does not provide one: a live capture against `pi-acp@0.0.32` (gitHead `2f6e3c5`) showed
a core `write` go `pending → in_progress → completed` with **zero** permission round-trips, and the
adapter's source confirmed the same path serves `read`/`edit`/`bash`. Its `requestPermission` is
invoked only for pi's own select/confirm UI, never for tool execution.

The practical consequence: a host cannot hold a repository read-only while pi works in it, so pi
gets excluded from exactly the contexts where a second independent model is most valuable.

`pi-governance` closes that by participating in pi's own tool pipeline rather than observing a
stream after the fact.

## Status

Early. Nothing is admitted until a live capture proves it — see **Admission** below.

## Admission

An adapter is not trusted because it claims to ask. It is trusted when a capture shows it asking.
The bar, deliberately the same one that disqualified the adapter this replaces:

1. Every tool kind — `read`, `edit`, `write`, `bash` — issues `session/request_permission` before
   execution.
2. A `write` **must not** reach `in_progress` without a permission response.
3. A denial is visible on the wire and the write does not happen.
4. The capture is stored as evidence and cites the exact pi and extension versions it was taken
   against.

A new pi or extension version re-runs the capture. A version that has not been captured is not
admitted, however small the change.

## Design notes

- **Defence in depth, not either/or.** pi also offers `--tools`, `--exclude-tools` and
  `--no-builtin-tools`. For a read-only context, withholding the write tools is a stronger
  guarantee than a prompt that must be both asked *and* honoured. This extension does not replace
  that; the two compose.
- **Why an extension.** pi has a first-class extension system (`pi install`, `-e <path>`,
  discovery under `~/.pi/agent/extensions`, extension-registered flags). That makes it possible for
  the permission boundary to be *inside* the tool pipeline, which is the only place it can be
  authoritative.

## License

MIT
