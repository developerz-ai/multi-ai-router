import { type CountEstimate, estimateTokenCount } from "./count-estimate"
import { attemptRecord } from "./records"
import type { DispatchRuntime } from "./runtime"

/**
 * Anthropic's `count_tokens` answer, plus the label that says this one is the router's own.
 *
 * `input_tokens` is the provider's own field name on purpose — Claude Code reads it as a
 * compaction threshold and does not care where the number came from, and this shape lets it work
 * unmodified. `estimated` and `estimate_basis` are the router's additions, and they are what make
 * the answer honest.
 */
export interface CountTokensEstimateBody {
  readonly input_tokens: number
  /** Always true here. Its presence is what distinguishes this from a provider's measurement. */
  readonly estimated: true
  readonly estimate_basis: string
}

/**
 * The labelled body the client receives.
 *
 * The three fields are emitted together, always. An `input_tokens` without `estimated` would be a
 * fabricated measurement wearing a provider's field name, which is the failure this whole path
 * exists to avoid.
 */
export function countTokensEstimateBody(estimate: CountEstimate): CountTokensEstimateBody {
  return {
    input_tokens: estimate.inputTokens,
    estimated: true,
    estimate_basis: estimate.basis,
  }
}

/**
 * Answer a `count_tokens` request the router had to answer for itself.
 *
 * The scope held nothing but Claude subscriptions, so no provider could be asked: the Agent SDK
 * states no token-count call, and the router will never forge an `api.anthropic.com` request out
 * of a subscription's credentials to get one. The answer comes from the body the router already
 * holds — no upstream addressed, no subprocess spawned, no account touched.
 *
 * It writes **one** usage row, and it is a success rather than a routing failure: no error class,
 * no account, no provider, and no egress mode, because none of those exist on this path. Its token
 * columns are zero and it is never priced, for the same reason the provider's own count is not
 * priced — a count measures a prompt nobody ran.
 */
export function countTokensEstimateResponse(
  body: Uint8Array,
  runtime: DispatchRuntime,
  startedAt: Date,
  requestStarted: number,
): Response {
  const estimate = estimateTokenCount(body)
  const event = attemptRecord({
    ...runtime.preflightAttribution(),
    // A count is never priced: zeroed counts against a priced model come back as
    // `metered $0.000000`, which reads as a free completion rather than as no completion.
    priced: false,
    timing: runtime.timing(startedAt, requestStarted, 0),
    outcome: "success",
    streamed: false,
    httpStatus: 200,
    responseStatus: 200,
    errorClass: null,
  })
  ;(runtime.recordTerminal ?? runtime.record)(event)
  return Response.json(countTokensEstimateBody(estimate))
}
