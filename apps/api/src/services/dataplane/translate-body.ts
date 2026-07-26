import type { OpenAiChatCeiling } from "@multi-ai-router/core"
import { TranslationError } from "@multi-ai-router/core"
import type { TranslationContext, TranslationPair } from "../translate"

/**
 * The upstream body a translate candidate sends — built lazily, and at most once per target shape.
 *
 * This is the one place `06-protocol-translation.md`'s "full parse only on demand" rule is spent.
 * A chain whose candidates are all passthrough never touches this module, so the parse is not on
 * the hot path; a chain that mixes modes pays for it only if a translated candidate is actually
 * reached, and a failover from one openai-chat account to another reuses the conversion rather
 * than redoing it.
 *
 * The **model** is re-applied per attempt rather than baked into the cached conversion. Two
 * accounts of the same dialect can carry different alias maps — `sonnet` to `glm-4.7` on one and
 * to `k3` on the next — and the model is the only field a *rename* can move.
 *
 * The **openai-chat ceiling** is the one thing beyond the model that varies per account, and it is
 * keyed into the cache rather than overlaid: `max_tokens` and `max_completion_tokens` are two names
 * for one field and only the translator that emits the body gets to decide which one it writes
 * (`OpenAiChatCeiling`). A chain of accounts that agree — the ordinary case — still converts once.
 */

export interface TranslatedRequestBody {
  /**
   * The bytes for this candidate.
   *
   * @throws TranslationError (400) naming the field with no representation in the target dialect,
   * or saying the body is not JSON at all. Thrown before any upstream call.
   */
  bodyFor(pair: TranslationPair, upstreamModel: string, chatCeiling: OpenAiChatCeiling): Uint8Array
}

const NOT_JSON = "The request body must be JSON for a cross-dialect request"
const EMPTY = "The request body is empty: there is nothing to translate"

export function createTranslatedRequestBody(
  bytes: Uint8Array,
  context: TranslationContext,
): TranslatedRequestBody {
  const encoder = new TextEncoder()
  // Keyed by target *shape*, not target dialect: see the ceiling note above.
  const converted = new Map<string, Record<string, unknown>>()
  let source: unknown
  let parsed = false

  const body = (): unknown => {
    if (parsed) return source
    parsed = true
    if (bytes.length === 0) throw new TranslationError(EMPTY)
    try {
      source = JSON.parse(new TextDecoder("utf-8").decode(bytes))
    } catch {
      throw new TranslationError(NOT_JSON)
    }
    return source
  }

  return {
    bodyFor(pair, upstreamModel, chatCeiling) {
      const shape = `${pair.egress}|${chatCeiling}`
      let translated = converted.get(shape)
      if (translated === undefined) {
        // A translator emits an object; anything else would mean a pair returning a body no
        // upstream could read, and asserting it here beats discovering it as a 400 from the
        // provider on a body we wrote.
        const result = pair.request(body(), { ...context, chatCeiling })
        if (typeof result !== "object" || result === null || Array.isArray(result)) {
          throw new TranslationError(
            `the ${pair.ingress} to ${pair.egress} conversion produced no body`,
          )
        }
        translated = result as Record<string, unknown>
        converted.set(shape, translated)
      }
      // Last, and unconditionally: the account's alias map is the operator saying which name this
      // upstream bills, and it must survive whatever the conversion put there.
      return encoder.encode(JSON.stringify({ ...translated, model: upstreamModel }))
    },
  }
}
