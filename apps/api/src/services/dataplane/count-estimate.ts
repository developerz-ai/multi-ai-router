/**
 * The router's own token-count estimate, for the one scope a provider cannot count for us.
 *
 * A Claude subscription reaches the router through the Agent SDK, and the SDK is a completion
 * transport: it states no token-count call, and the one thing this router will never do to reach
 * an endpoint it lacks is forge an `api.anthropic.com` request out of a subscription's credentials
 * (docs/idea/11-anthropic-agent-sdk.md). So a scope holding nothing but subscriptions has no
 * provider to ask.
 *
 * What it has instead is the request body, already in memory, and a client that needs a number to
 * decide when to compact its context. So the router answers with an **estimate**, and — this is the
 * whole point — says so in the body:
 *
 *     { "input_tokens": 1234, "estimated": true, "estimate_basis": "chars-per-token-v1" }
 *
 * `input_tokens` keeps Anthropic's name so an unmodified client reads it as the threshold it
 * expects; `estimated` is what makes the difference from a measurement visible to anything that
 * looks. The three fields always travel together — an estimate that answered with `input_tokens`
 * alone would be indistinguishable from a provider's number, which is the one thing this must not
 * be.
 *
 * The number itself is a **documented approximation**: this router ships no Claude tokenizer, so
 * the count is derived from the size of the request rather than from the provider's own
 * vocabulary. It is rounded **up**, because the direction of the error matters — a client that
 * compacts slightly early loses a little context, and a client that compacts late blows its
 * window.
 *
 * The estimate itself is pure: no clock, no I/O, no network, no store. The same bytes always
 * produce the same number.
 */

import { attemptRecord } from "./records"
import type { DispatchRuntime } from "./runtime"

/**
 * Characters per token, for the estimate.
 *
 * A named constant and not a literal buried in an expression: the divisor is the whole claim this
 * module makes, so it has to be one value a reader can find, change, and argue with — not a `4`
 * that appears once and is never seen again.
 */
export const ESTIMATE_CHARS_PER_TOKEN = 4

/**
 * Machine-readable label for how the number was produced. Short, stable, and part of the wire
 * shape: a client that wants to know whether it is reading a measurement can compare it.
 */
export const ESTIMATE_BASIS = "chars-per-token-v1"

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

/** The estimate itself: a token count and the basis it was derived on. */
export interface CountEstimate {
  readonly inputTokens: number
  readonly basis: string
}

/** JSON's own punctuation, which carries no prompt. */
const STRUCTURAL: ReadonlySet<string> = new Set(["{", "}", "[", "]", ",", ":", '"'])

/**
 * Count the characters of the body that a tokenizer would actually see.
 *
 * The body is JSON, and JSON's own punctuation is not prompt: the braces, the brackets, the
 * commas, the colons, and the quotes around every key and string are structure, not content. They
 * are excluded here, so the estimate tracks the text a model would read rather than the envelope
 * around it.
 *
 * Decoded as UTF-8 because the body is text in a JSON envelope; a byte that is not valid UTF-8
 * decodes to the replacement character and is counted as one character, which is the honest
 * outcome for a body that was never a prompt.
 */
function textualCharacters(text: string): number {
  let count = 0
  for (const character of text) {
    if (STRUCTURAL.has(character)) continue
    count += 1
  }
  return count
}

/**
 * The estimate for one request body.
 *
 * Rounded **up**: an over-estimate is the safe direction for a compaction threshold (compact
 * earlier rather than blow the context window), and it is the direction the count is deliberately
 * biased towards everywhere else in this router.
 */
export function estimateTokenCount(body: Uint8Array): CountEstimate {
  const text = new TextDecoder().decode(body)
  const characters = textualCharacters(text)
  const tokens = Math.ceil(characters / ESTIMATE_CHARS_PER_TOKEN)
  return { inputTokens: tokens, basis: ESTIMATE_BASIS }
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
