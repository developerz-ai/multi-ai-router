import type { UpstreamStartGuard } from "../../providers/upstream-admission"
import { type AttemptOutcome, runAttempt } from "./attempt"
import type { attemptQuota } from "./attempt-quota"
import type { ChainContext } from "./chain"
import { routerCacheKey } from "./chain-body"
import { cacheKeyHeader, conversationId, effectiveCacheKey } from "./egress/cache-key-header"
import { forcesUpstreamStream, type ServableCandidate } from "./plan"
import { runSdkAttempt } from "./sdk-attempt"

/**
 * The one place the two transports diverge. Both answer with the same `AttemptOutcome`, so the loop
 * above, the health store, the records, and the relay below are written once — from here down,
 * nothing can tell a re-synthesized SDK `Response` from one relayed off a socket.
 */
export async function dispatch(
  ctx: ChainContext,
  servable: ServableCandidate,
  body: Uint8Array | null,
  inPlaceReplay: boolean,
  beforeUpstreamStart?: UpstreamStartGuard,
  onUpstreamStarted?: () => void,
  rateLimitObserver?: ReturnType<typeof attemptQuota>,
): Promise<AttemptOutcome> {
  const { runtime } = ctx
  if (servable.kind === "sdk") {
    return runSdkAttempt({
      clientHeaders: ctx.request.headers,
      apiKeyId: runtime.apiKeyId,
      sessionKey: runtime.sessionKey,
      plan: servable,
      body,
      beforeUpstreamStart,
      onUpstreamStarted,
      ...(rateLimitObserver === undefined ? {} : { rateLimitObserver }),
      invoke: runtime.invokeSdk,
      session: runtime.session,
      quota: runtime.quota,
      now: runtime.clock.now,
      ...(runtime.unknownResetRetryAfterSeconds === undefined
        ? {}
        : { unknownResetRetryAfterSeconds: runtime.unknownResetRetryAfterSeconds }),
      timeoutMs: runtime.timeoutMs,
      ...(runtime.gateWait === undefined ? {} : { gateWait: runtime.gateWait() }),
      ...(ctx.streamRequested === true && runtime.sdkStreamDeadlines !== undefined
        ? { stream: runtime.sdkStreamDeadlines }
        : {}),
      signal: ctx.request.signal,
      // The planner only ever replays in place after `stale-session`, so this attempt already
      // knows the SDK disowned the resumed id — the lineage plan must not offer it again.
      sessionGone: inPlaceReplay,
      ...(ctx.log === undefined ? {} : { log: ctx.log }),
    })
  }

  // After `bodyFor`, so a translated request's cached parse is there to read the caller's key from.
  const cacheKey = cacheKeyHeader(
    servable.responsesEgress.cacheKeyHeader,
    servable.translation === null
      ? { kind: "relay", client: ctx.request.headers }
      : {
          kind: "translated",
          key: effectiveCacheKey(ctx.translated.promptCacheKey(), routerCacheKey(ctx, servable)),
        },
  )
  const namesConversation = servable.driver.sessionHeader?.(servable.account.driver) !== undefined
  const streamDeadlines = deadlinesFor(ctx, servable)
  let started = false
  const outcome = await runAttempt({
    plan: servable,
    beforeUpstreamStart,
    onUpstreamStarted: () => {
      onUpstreamStarted?.()
      started = true
    },
    method: ctx.request.method,
    clientHeaders: ctx.request.headers,
    body,
    fetch: runtime.call,
    cipher: runtime.cipher,
    timeoutMs: runtime.timeoutMs,
    ...(runtime.errorMaxBytes === undefined ? {} : { errorMaxBytes: runtime.errorMaxBytes }),
    signal: ctx.request.signal,
    ...(runtime.activeRequest === undefined ? {} : { abandon: runtime.activeRequest.signal }),
    clientStreams: ctx.streamRequested === true,
    ...(forcesUpstreamStream(servable) ? { accept: "text/event-stream" } : {}),
    ...(cacheKey === undefined ? {} : { cacheKey }),
    ...(namesConversation
      ? { conversationId: conversationId(runtime.apiKeyId, runtime.sessionKey) }
      : {}),
    ...(streamDeadlines === undefined ? {} : { stream: streamDeadlines }),
    ...(runtime.silentHold === undefined ? {} : { silentHold: runtime.silentHold }),
  })
  if (outcome.kind !== "failure") return outcome
  // Read here, while the attempt still holds its own count: the chain gives it back
  // (`lifetime.end()`) before the failure line is written, which would leave it out (#509).
  const inFlight = started ? runtime.health.stateOf(servable.account.id).inFlight : undefined
  return {
    ...outcome,
    evidence: {
      model: servable.upstreamModel,
      ...(inFlight === undefined ? {} : { inFlight }),
      ...(outcome.upstream === null ? {} : { headers: outcome.upstream.headers }),
    },
  }
}

/**
 * The streaming clocks apply only where the upstream answers as a stream: the client asked for one,
 * or the surface forces one. A non-streamed answer's headers arrive with the finished completion.
 */
function deadlinesFor(ctx: ChainContext, servable: ServableCandidate) {
  const streams = ctx.streamRequested === true || forcesUpstreamStream(servable)
  return streams ? ctx.runtime.streamDeadlines : undefined
}
