import type { Logger } from "../../logging/logger"
import type { AttemptFailure } from "../routing"
import type { TranslationContext } from "../translate"
import { createTokenObserver, NO_TOKEN_OBSERVER } from "../usage"
import type { UpstreamError } from "./attempt"
import type { ServableCandidate } from "./plan"
import { attemptRecord, failureOutcome, SUCCESS_OUTCOME } from "./records"
import { relayResponse } from "./relay"
import { relayTranslatedResponse } from "./relay-translate"
import type { DispatchRuntime } from "./runtime"

/**
 * What one attempt leaves behind: the bytes the client gets, and the `UsageRecord` that says what
 * it cost. Split from `chain.ts` because the two change for different reasons — that file decides
 * *which account is tried next*, this one decides *how an attempt is accounted for* — and because a
 * success settles long after the chain returned, so its bookkeeping outlives the loop that started
 * it.
 *
 * Every attempt writes a row, including every failure. That is the spec's requirement, not a
 * debugging aid: an operator cannot see a pool degrading from the successes alone.
 */

/** Readings taken when the attempt began. `upstreamMs` is the wait accumulated *before* it. */
export interface AttemptClock {
  readonly startedAt: Date
  readonly started: number
  readonly upstreamMs: number
}

/**
 * The slice of the chain's context an attempt's accounting reads. `ChainContext` satisfies it
 * structurally, so the chain passes itself and nothing has to be threaded or rebuilt.
 */
export interface AttemptRelay {
  readonly runtime: DispatchRuntime
  readonly translation: TranslationContext
  readonly log: Logger | undefined
}

export function relaySuccess(
  ctx: AttemptRelay,
  servable: ServableCandidate,
  attempt: number,
  response: Response,
  at: AttemptClock,
): Response {
  // A count-tokens answer states `input_tokens` for a prompt that was never run. Reading it would
  // record — and price — a measurement as though it were a completion, so that one response shape
  // is relayed and observed for bytes only. See `usage/tokens.ts`. An embeddings answer is the
  // opposite case and takes the ordinary observer: its `prompt_tokens` were genuinely spent, and
  // the absent completion count lands as the zero it truthfully is.
  const counting = ctx.runtime.operation === "count-tokens"
  const tokens = counting ? NO_TOKEN_OBSERVER : createTokenObserver()
  let firstByteAt: number | undefined
  const settle = (streamed: boolean): void => {
    // Everything this attempt spent — the call and every byte relayed off it — is time the router
    // waited on the upstream, not time it worked. The failure path adds its attempt before
    // recording; the success path has to add its own here, at the moment the last byte lands,
    // because a stream settles long after the loop returned. Passing only the *previous* attempts'
    // wait would fold a whole generation into `router_overhead_seconds`, the one series that must
    // never contain upstream time (CLAUDE.md non-negotiable 8).
    const upstreamMs = at.upstreamMs + (ctx.runtime.clock.elapsed() - at.started)
    const counts = tokens.counts()
    ctx.runtime.health.endAttempt(servable.account.id, counts.tokensOut)
    ctx.runtime.record(
      attemptRecord({
        ...ctx.runtime.attribution(attempt, servable),
        tokens: counts,
        // Zeroed counts are not a zero *bill*: on a model the table prices they would record
        // `metered $0.000000`, which sums into a spend report as a completion that cost nothing.
        priced: !counting,
        timing: ctx.runtime.timing(at.startedAt, at.started, upstreamMs, firstByteAt),
        outcome: SUCCESS_OUTCOME,
        streamed,
        httpStatus: response.status,
        errorClass: null,
      }),
    )
  }

  const observer = {
    onFirstByte: () => {
      firstByteAt = ctx.runtime.clock.elapsed()
    },
    onChunk: (chunk: Uint8Array) => tokens.observe(chunk),
    onEnd: (bytes: number) => settle(bytes > 0),
    // A stream that broke after bytes were on the wire is a truncation, never a retry.
    onError: () => settle(true),
  }

  const pair = servable.translation
  if (pair === null) return relayResponse(response, observer)

  return relayTranslatedResponse({
    upstream: response,
    pair,
    context: ctx.translation,
    observer,
    onUnrecognizedStopReason: (reason) =>
      ctx.log?.warn("upstream reported an unrecognized stop reason", {
        accountId: servable.account.id,
        provider: servable.account.driver.provider,
        stopReason: reason,
      }),
  })
}

export function recordAttemptFailure(
  ctx: AttemptRelay,
  servable: ServableCandidate,
  attempt: number,
  failure: AttemptFailure,
  upstream: UpstreamError | null,
  at: AttemptClock,
): void {
  ctx.runtime.record(
    attemptRecord({
      ...ctx.runtime.attribution(attempt, servable),
      // Same rule on the way down: a count that never landed is no more priceable than one that did.
      priced: ctx.runtime.operation !== "count-tokens",
      timing: ctx.runtime.timing(at.startedAt, at.started, at.upstreamMs),
      outcome: failureOutcome(failure.kind),
      streamed: false,
      httpStatus: upstream?.status ?? null,
      errorClass: null,
    }),
  )
}
