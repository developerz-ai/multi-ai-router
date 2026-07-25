/**
 * The one reviewed constant naming every tool the Agent SDK subprocess is permitted to execute on
 * this host — and the predicate that enforces it.
 *
 * The SDK's built-ins (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, …) run **on the
 * router**. Leaving any of them reachable is arbitrary command execution for anyone holding any
 * router key: `ENCRYPTION_KEY`, the Postgres credentials, and every Account's `CLAUDE_CONFIG_DIR`
 * sit on that filesystem (docs/idea/07-security.md#tool-execution, CLAUDE.md non-negotiable 2).
 *
 * Three properties are load-bearing, and each rules out a cheaper design:
 *
 * - **An allowlist, never a blocklist.** A blocklist fails open the day the SDK ships a new
 *   built-in — and it ships them regularly. This list is closed by construction: a name that is not
 *   here cannot run, whatever the SDK adds.
 * - **Never a default.** "We pass `tools: []`, so nothing is offered" is an argument about what the
 *   model is *shown*, not about what the harness will *run*. Absence is not a decision; this file
 *   is. `tools: []` still ships (`options.ts`) because it also elides the ~25 k-token built-in
 *   catalog from the upstream payload — but it is the second lock, not the first.
 * - **Adding a name here is a security change.** That is the whole point of the list being one
 *   constant in one file: a reviewer sees the diff.
 *
 * **The list is empty, and empty is the decision.** Passthrough is the only supported mode: a
 * captured `tool_use` is forwarded to the client, which owns the user's filesystem, working
 * directory, and consent, and which is the thing that should have been executing tools all along.
 * There is no tool the router needs to run on the caller's behalf, so nothing qualifies.
 *
 * The one name that will plausibly earn a place later is `ToolSearch` — the SDK needs it for
 * deferred tool loading once the client's own tools are registered above the ~15-tool threshold
 * (docs/idea/11-anthropic-agent-sdk.md#7-tool-handling--the-genuinely-hard-part). It is absent
 * today because that registration does not exist yet, and naming a tool we cannot offer would be a
 * permission granted for nothing.
 */

/**
 * Every tool name the SDK subprocess may execute on this host. Exact, case-sensitive matches.
 *
 * Frozen so a caller cannot widen the policy at runtime — a mutable module-level array is a
 * one-line escalation from anywhere in the process.
 *
 * A name here is a *full* grant: the SDK auto-approves bare `allowedTools` entries before
 * `canUseTool` is consulted, so the permission callback cannot narrow one afterwards. Grant the
 * tool or do not list it; there is no third state.
 */
export const PERMITTED_TOOLS: readonly string[] = Object.freeze([])

/**
 * A `Set`, not an object literal: an object used as a closed-set lookup resolves inherited keys, so
 * `isPermittedTool("constructor")` would answer `true` and hand the model a permit nobody wrote.
 */
const PERMITTED = new Set<string>(PERMITTED_TOOLS)

/** Whether `name` may execute here. Anything not named above is refused, including unknown names. */
export function isPermittedTool(name: string): boolean {
  return PERMITTED.has(name)
}

/**
 * Why a tool call was refused, in words a model can act on and a caller can read.
 *
 * States the router's contract rather than an internal failure, because the model's next move
 * should be to emit the call for the client to execute — not to retry it here. Carries nothing but
 * the name the model itself chose: no path, no environment, no host detail.
 */
export function toolDenial(name: string): string {
  return `${name} is not executed by this router: tool calls are returned to the client, which runs them`
}
