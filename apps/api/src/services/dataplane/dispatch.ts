import { type AttemptOutcome, runAttempt } from "./attempt"
import type { ChainContext } from "./chain"
import type { ServableCandidate } from "./plan"
import { runSdkAttempt } from "./sdk-attempt"

/**
 * The one place the two transports diverge. Both answer with the same `AttemptOutcome`, so the loop
 * above, the health store, the records, and the relay below are written once — from here down,
 * nothing can tell a re-synthesized SDK `Response` from one relayed off a socket.
 */
export function dispatch(
  ctx: ChainContext,
  servable: ServableCandidate,
  body: Uint8Array | null,
  inPlaceReplay: boolean,
): Promise<AttemptOutcome> {
  const { runtime } = ctx
  if (servable.kind === "sdk") {
    return runSdkAttempt({
      plan: servable,
      body,
      invoke: runtime.invokeSdk,
      session: runtime.session,
      quota: runtime.quota,
      now: runtime.clock.now,
      timeoutMs: runtime.timeoutMs,
      signal: ctx.request.signal,
      // The planner only ever replays in place after `stale-session`, so this attempt already
      // knows the SDK disowned the resumed id — the lineage plan must not offer it again.
      sessionGone: inPlaceReplay,
      ...(ctx.log === undefined ? {} : { log: ctx.log }),
    })
  }

  return runAttempt({
    plan: servable,
    method: ctx.request.method,
    clientHeaders: ctx.request.headers,
    body,
    fetch: runtime.call,
    cipher: runtime.cipher,
    timeoutMs: runtime.timeoutMs,
    signal: ctx.request.signal,
  })
}
