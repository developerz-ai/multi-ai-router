import { z } from "zod"
import type { UpstreamErrorFacts } from "../types"

/**
 * Provider error bodies are external data, so they are Zod-validated at this boundary: unknown
 * fields are tolerated, a reshaped payload simply yields no facts rather than a thrown parse
 * error, and classification then falls back to the HTTP status. A silently reshaped payload must
 * degrade to "status only", never to a wrong verdict.
 *
 * One tolerant envelope covers both dialects — Anthropic's `{type,error:{type,message}}` and
 * OpenAI's `{error:{message,type,code,param}}` overlap enough that separating them would be two
 * schemas for one job. Provider-specific shapes (MiniMax's `base_resp`) live with their driver.
 */

/**
 * One error object's fields, each read on its own: a vendor sending `type: null` (Azure, LiteLLM and
 * most gateways do) or an object where a string belongs costs that field and never the `code` beside
 * it. Read strictly, one null dropped `code: "insufficient_quota"` and a dead balance classified as a
 * throttle on its `429`.
 */
export const ErrorFields = z.object({
  type: z.string().nullish().catch(undefined),
  message: z.string().nullish().catch(undefined),
  code: z.union([z.string(), z.number()]).nullish().catch(undefined),
})

export function factsOf(fields: z.infer<typeof ErrorFields>): UpstreamErrorFacts {
  return {
    type: fields.type ?? undefined,
    code: textOf(fields.code),
    message: fields.message ?? undefined,
  }
}

const ErrorEnvelope = z.object({ error: z.union([z.string(), ErrorFields]) })

/**
 * The other envelope in the wild: the same four fields with **no `error` wrapper**. Mistral
 * publishes it (`{object:"error", message, type, param, code}`) and Cerebras answers in it, so two
 * drivers would otherwise each carry a copy of this parse.
 *
 * `message` is required rather than optional, and that is the whole safety argument: no successful
 * OpenAI-shaped body — a completion, an embedding list, a model listing — carries a top-level
 * `message`, so a success can never be read as a failure through this shape.
 */
const FlatErrorEnvelope = ErrorFields.extend({ message: z.string() })

function textOf(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  return String(value)
}

/**
 * Normalizes an error body into the facts the classification rules read. Accepts a raw string
 * body — a gateway in front of a provider may answer with plain text or HTML, and that is still
 * a message worth carrying.
 */
export function readErrorFacts(body: unknown): UpstreamErrorFacts {
  if (typeof body === "string") {
    const trimmed = body.trim()
    if (trimmed === "") return {}
    try {
      return readErrorFacts(JSON.parse(trimmed))
    } catch {
      return { message: trimmed }
    }
  }

  const parsed = ErrorEnvelope.safeParse(body)
  if (!parsed.success) return {}

  const error = parsed.data.error
  return typeof error === "string" ? { message: error } : factsOf(error)
}

function hasFacts(facts: UpstreamErrorFacts): boolean {
  return facts.type !== undefined || facts.code !== undefined || facts.message !== undefined
}

/**
 * The shared envelope first, then the unwrapped one. In that order because a provider that answers
 * both — a gateway relaying an OpenAI-shaped body in front of a flat-shaped vendor — should be read
 * as what it sent, and because the flat shape is the looser match of the two.
 */
export function readFlatErrorFacts(body: unknown): UpstreamErrorFacts {
  const nested = readErrorFacts(body)
  if (hasFacts(nested)) return nested

  const parsed = FlatErrorEnvelope.safeParse(body)
  return parsed.success ? factsOf(parsed.data) : nested
}
