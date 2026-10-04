import type { DropSink } from "./drops"

/**
 * What a particular OpenAI Responses *surface* demands of a body the router writes for it.
 *
 * The Responses dialect is one wire shape, but not every upstream speaking it accepts all of it.
 * The ChatGPT Codex backend refuses a non-streaming request, refuses one without `instructions`,
 * and refuses sampling and ceiling fields its first-party client never sends. Those are facts about
 * the upstream, so the **driver** declares them (`providers/drivers/*`) and the translator reads
 * them from its context — no provider name is ever tested in this directory (non-negotiable 12),
 * and the translator stays a pure function of body + rules (non-negotiable 9).
 *
 * Applied only to bodies the router *wrote* — a cross-dialect request. A same-dialect `/v1/responses`
 * body is a byte relay and is never parsed to apply these (non-negotiable 10).
 */
export interface ResponsesEgressRules {
  /** The upstream answers only as SSE: `stream` is sent `true` whatever the client asked. */
  readonly requireStream: boolean
  /** The upstream rejects a body with no `instructions`; an absent prompt is sent as `""`. */
  readonly requireInstructions: boolean
  /** Top-level Responses fields the upstream refuses. Removed, and reported by name. */
  readonly unsupportedFields: readonly string[]
}

export const DEFAULT_RESPONSES_EGRESS: ResponsesEgressRules = {
  requireStream: false,
  requireInstructions: false,
  unsupportedFields: [],
}

const REFUSED_BY_SURFACE = "the target account's Responses surface refuses this field"

export function applyResponsesEgressRules(
  body: unknown,
  rules: ResponsesEgressRules | undefined,
  onDrop: DropSink | undefined,
): unknown {
  if (rules === undefined || typeof body !== "object" || body === null || Array.isArray(body)) {
    return body
  }
  const out: Record<string, unknown> = { ...body }
  for (const field of rules.unsupportedFields) {
    if (out[field] === undefined) continue
    delete out[field]
    onDrop?.({ field, reason: REFUSED_BY_SURFACE })
  }
  if (rules.requireStream) out.stream = true
  if (rules.requireInstructions && typeof out.instructions !== "string") out.instructions = ""
  return out
}
