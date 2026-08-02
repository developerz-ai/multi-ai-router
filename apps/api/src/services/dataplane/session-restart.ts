/**
 * The client-visible surfacing of a restarted upstream session.
 *
 * `binding.ts` and `result.ts` promise that a dropped Session -> Account binding is "surfaced,
 * never silently truncated" (docs/idea/05-routing-and-failover.md, "Say so, don't fake it").
 * This is the surface: one response header, set on the turn that started a fresh upstream
 * session where a bound one used to be. Both places that can happen route through here —
 *
 * - **preflight**: the binding was invalidated before selection ran (`rebind` on a cooling
 *   account, an out-of-scope or exhausted account, a removed one) — the orchestrator stamps it;
 * - **mid-chain**: failover left the bound account for another candidate — the chain stamps it.
 *
 * A header rather than a body edit because the response body is the model's answer, relayed or
 * re-synthesized byte-exactly, and is not the router's to annotate. Clients that resend their
 * full history every turn (the population `rebind` exists for) lose no content — the header
 * tells the ones that do not that upstream-side context from prior turns is gone.
 */

export const SESSION_RESTART_HEADER = "x-router-session-restart"

/** Why the session restarted — a `BindingInvalidationReason`, or `failover` for a mid-chain hop. */
export type SessionRestartReason = string

/**
 * Stamps the header, copying the response only when its headers are immutable. The body stream is
 * carried by reference either way — nothing is buffered.
 */
export function withSessionRestart(response: Response, reason: SessionRestartReason): Response {
  try {
    response.headers.set(SESSION_RESTART_HEADER, reason)
    return response
  } catch {
    const copy = new Response(response.body, response)
    copy.headers.set(SESSION_RESTART_HEADER, reason)
    return copy
  }
}
