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

const ErrorEnvelope = z.object({
  error: z.union([
    z.string(),
    z.object({
      type: z.string().optional(),
      message: z.string().optional(),
      code: z.union([z.string(), z.number()]).nullish(),
    }),
  ]),
})

/**
 * The other envelope in the wild: the same four fields with **no `error` wrapper**. Mistral
 * publishes it (`{object:"error", message, type, param, code}`) and Cerebras answers in it, so two
 * drivers would otherwise each carry a copy of this parse.
 *
 * `message` is required rather than optional, and that is the whole safety argument: no successful
 * OpenAI-shaped body — a completion, an embedding list, a model listing — carries a top-level
 * `message`, so a success can never be read as a failure through this shape.
 */
const FlatErrorEnvelope = z.object({
  message: z.string(),
  type: z.string().optional(),
  code: z.union([z.string(), z.number()]).nullish(),
})

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
  if (typeof error === "string") return { message: error }

  return { type: error.type, code: textOf(error.code), message: error.message }
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
  if (!parsed.success) return nested

  return {
    type: parsed.data.type,
    code: textOf(parsed.data.code),
    message: parsed.data.message,
  }
}
