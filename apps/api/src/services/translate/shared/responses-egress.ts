import { type DropSink, IGNORE_DROPS } from "./drops"
import { stripLookaroundPatternsFromTools } from "./schema-lookarounds"

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
  /**
   * The upstream compiles each tool schema's JSON-Schema `pattern`s and refuses a regex lookaround
   * (`(?=`, `(?!`, `(?<=`, `(?<!`) with a `400`. When true, a `pattern` containing one is removed
   * from translated tool schemas and reported by tool name and schema path, never by value. Which
   * keywords are walked, and what is out of scope, is documented in `schema-lookarounds.ts`.
   */
  readonly stripLookaroundPatterns: boolean
  /**
   * The request header this upstream derives prompt-cache affinity from, or absent when it reads
   * only the body. Unlike the rules above it applies to **both** modes, because it touches no body
   * byte: a translated request sends the caller's `prompt_cache_key` under it, and a byte relay
   * forwards the client's own header of that name. See `dataplane/egress/cache-key-header.ts`.
   */
  readonly cacheKeyHeader?: string | undefined
}

export const DEFAULT_RESPONSES_EGRESS: ResponsesEgressRules = {
  requireStream: false,
  requireInstructions: false,
  unsupportedFields: [],
  stripLookaroundPatterns: false,
}

const REFUSED_BY_SURFACE = "the target account's Responses surface refuses this field"

const NONE: ReadonlySet<string> = new Set()

/**
 * @param everyRequest Responses fields the ingress dialect puts on *every* body — Anthropic's
 * mandatory `max_tokens` lands as `max_output_tokens`. Removing one is still done, but not
 * reported: a drop every request carries is a documented hint, and a warn line per request says
 * nothing (`shared/drops.ts`). Prod, 2026-10-16: 174 such lines an hour, one per Claude Code turn
 * routed to a ChatGPT account.
 */
export function applyResponsesEgressRules(
  body: unknown,
  rules: ResponsesEgressRules | undefined,
  onDrop: DropSink | undefined,
  everyRequest: ReadonlySet<string> = NONE,
): unknown {
  if (rules === undefined || typeof body !== "object" || body === null || Array.isArray(body)) {
    return body
  }
  let out: Record<string, unknown> = { ...body }
  for (const field of rules.unsupportedFields) {
    if (out[field] === undefined) continue
    delete out[field]
    if (!everyRequest.has(field)) onDrop?.({ field, reason: REFUSED_BY_SURFACE })
  }
  if (rules.requireStream) out.stream = true
  if (rules.requireInstructions && typeof out.instructions !== "string") out.instructions = ""
  if (rules.stripLookaroundPatterns) {
    out = stripLookaroundPatternsFromTools(out, onDrop ?? IGNORE_DROPS)
  }
  return out
}
