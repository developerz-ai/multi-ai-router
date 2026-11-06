import { type Dialect, InvalidRequestError } from "@multi-ai-router/core"
import type { TranslationPair } from "../translate"

/**
 * `x-router-usage: cost` — a caller's opt-in to `usage.cost` on a same-dialect answer (#335).
 *
 * A translated answer already states its cost (`relay-cost.ts`): its bytes are the router's own.
 * A same-dialect relay is byte passthrough (non-negotiable 10) and states none — unless the caller
 * asks with this header, which trades byte identity for the figure on that one request. The answer
 * is then re-framed through the translated relay with an identity pair: a JSON body is parsed and
 * re-serialized with the cost in its `usage`, a stream is re-framed per SSE event with the cost in
 * the dialect's final usage frame. Content and order are unchanged; formatting and SSE fields other
 * than `event:`/`data:` are not kept. Absent, nothing changes: same bytes, same latency.
 *
 * Read off the client's request and never forwarded: `egress/headers.ts` sends an allowlist only.
 * docs/idea/06-protocol-translation.md#per-call-cost-on-the-wire.
 */
export const ROUTER_USAGE_HEADER = "x-router-usage"

const USAGE_OPTIONS = new Set(["cost"])

/**
 * Whether the caller asked for the cost. An unknown value is refused (`400`) at preflight rather
 * than ignored: a typo would otherwise read as "the router has no cost for this".
 */
export function costRequested(headers: Pick<Headers, "get">): boolean {
  const value = headers.get(ROUTER_USAGE_HEADER)
  if (value === null) return false
  const options = value.split(",").map((option) => option.trim().toLowerCase())
  const unknown = options.find((option) => !USAGE_OPTIONS.has(option))
  if (unknown !== undefined) {
    throw new InvalidRequestError(
      `${ROUTER_USAGE_HEADER} names "${unknown.slice(0, 32)}", which the router does not report; the one option is "cost"`,
    )
  }
  return true
}

/** The upstream's own answer in its own dialect, frame for frame: only the cost stamp changes it. */
export function restampingPair(dialect: Dialect): TranslationPair {
  return {
    ingress: dialect,
    egress: dialect,
    request: (body) => body,
    response: (body) => ({ body, unrecognizedStopReason: null }),
    stream: () => ({
      push: (frame) => [
        frame.event === null ? { data: frame.data } : { event: frame.event, data: frame.data },
      ],
      flush: () => [],
      unrecognizedStopReason: () => null,
    }),
  }
}
