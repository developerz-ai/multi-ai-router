import type { Dialect } from "@multi-ai-router/core"
import { z } from "zod"
import type { TokenCounts } from "./tokens"

const objectSchema = z.record(z.string(), z.unknown())
const countSchema = z.number().int().min(0).max(2147483647)
export function responseObject(value: unknown): Record<string, unknown> | undefined {
  const result = objectSchema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Complete samples are atomic; Anthropic explicitly splits input/start and output/delta. */
export function readResponseUsage(
  dialect: Dialect,
  payload: unknown,
  event: string | undefined,
  previous: TokenCounts,
): { readonly counts: TokenCounts; readonly invalid: boolean } {
  const root = responseObject(payload)
  const type = root?.type ?? event
  const parent =
    dialect === "anthropic" && type === "message_start"
      ? responseObject(root?.message)
      : dialect === "openai-responses" && typeof type === "string" && type.startsWith("response.")
        ? responseObject(root?.response)
        : root
  if (parent?.usage === undefined || parent.usage === null)
    return { counts: previous, invalid: false }
  const usage = responseObject(parent.usage)
  if (!usage) return { counts: previous, invalid: true }
  const fields =
    dialect === "openai-chat"
      ? ["prompt_tokens", "completion_tokens"]
      : ["input_tokens", "output_tokens"]
  const input = usage[fields[0] ?? ""]
  const output = usage[fields[1] ?? ""]
  const detailsKey = dialect === "openai-chat" ? "prompt_tokens_details" : "input_tokens_details"
  const details = responseObject(usage[detailsKey])
  if (
    dialect !== "anthropic" &&
    usage[detailsKey] !== undefined &&
    usage[detailsKey] !== null &&
    !details
  )
    return { counts: previous, invalid: true }
  const cache =
    dialect === "anthropic"
      ? usage.cache_read_input_tokens
      : // DeepSeek states its cache hit beside the details object rather than inside it.
        (details?.cached_tokens ??
        (dialect === "openai-chat" ? usage.prompt_cache_hit_tokens : undefined))
  // Only OpenRouter states an OpenAI-shaped cache write (an Anthropic model behind it); every other
  // OpenAI-shaped upstream bills no separate write, so its absence is a measured zero.
  const write =
    dialect === "anthropic" ? usage.cache_creation_input_tokens : details?.cache_write_tokens
  const values = [input, output, cache, write]
  if (values.some((value) => value !== undefined && !countSchema.safeParse(value).success))
    return { counts: previous, invalid: true }
  if (values.every((value) => value === undefined)) return { counts: previous, invalid: false }
  const numericInput = typeof input === "number" ? input : undefined
  const numericOutput = typeof output === "number" ? output : undefined
  const numericCache = typeof cache === "number" ? cache : undefined
  const numericWrite = typeof write === "number" ? write : undefined
  if (dialect !== "anthropic") {
    // Cache belongs to this complete sample, never a maximum from an unrelated event. The input
    // total includes both cache components, so the uncached remainder is what is left of it.
    const cached = (numericCache ?? 0) + (numericWrite ?? 0)
    if (numericInput === undefined || cached > numericInput)
      return { counts: previous, invalid: true }
    return {
      counts: {
        tokensIn: numericInput - cached,
        tokensOut: numericOutput ?? 0,
        cacheReadTokens: numericCache ?? 0,
        cacheWriteTokens: numericWrite ?? 0,
      },
      invalid: false,
    }
  }
  if (numericInput === undefined && (numericCache !== undefined || numericWrite !== undefined))
    return { counts: previous, invalid: true }
  // `message_start` is a complete input bundle: a field it leaves out is zero for that message. A
  // `message_delta` only restates what it names — several Anthropic-compatible upstreams repeat
  // `input_tokens` there without the cache fields — so an absent field keeps the earlier reading.
  const bundle = type === "message_start" && numericInput !== undefined
  return {
    counts: {
      tokensIn: numericInput ?? previous.tokensIn,
      tokensOut: Math.max(numericOutput ?? 0, previous.tokensOut),
      cacheReadTokens: numericCache ?? (bundle ? 0 : previous.cacheReadTokens),
      cacheWriteTokens: numericWrite ?? (bundle ? 0 : previous.cacheWriteTokens),
    },
    invalid: false,
  }
}
