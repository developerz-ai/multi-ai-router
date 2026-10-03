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
  const cache = dialect === "anthropic" ? usage.cache_read_input_tokens : details?.cached_tokens
  const write = dialect === "anthropic" ? usage.cache_creation_input_tokens : undefined
  const values = [input, output, cache, write]
  if (values.some((value) => value !== undefined && !countSchema.safeParse(value).success))
    return { counts: previous, invalid: true }
  if (values.every((value) => value === undefined)) return { counts: previous, invalid: false }
  const numericInput = typeof input === "number" ? input : undefined
  const numericOutput = typeof output === "number" ? output : undefined
  const numericCache = typeof cache === "number" ? cache : undefined
  const numericWrite = typeof write === "number" ? write : undefined
  if (dialect !== "anthropic") {
    // Cache belongs to this complete sample, never a maximum from an unrelated event.
    if (numericInput === undefined || (numericCache ?? 0) > numericInput)
      return { counts: previous, invalid: true }
    return {
      counts: {
        tokensIn: numericInput - (numericCache ?? 0),
        tokensOut: numericOutput ?? 0,
        cacheReadTokens: numericCache ?? 0,
        cacheWriteTokens: 0,
      },
      invalid: false,
    }
  }
  if (numericInput === undefined && (numericCache !== undefined || numericWrite !== undefined))
    return { counts: previous, invalid: true }
  return {
    counts: {
      tokensIn: numericInput ?? previous.tokensIn,
      tokensOut: Math.max(numericOutput ?? 0, previous.tokensOut),
      cacheReadTokens: numericInput === undefined ? previous.cacheReadTokens : (numericCache ?? 0),
      cacheWriteTokens:
        numericInput === undefined ? previous.cacheWriteTokens : (numericWrite ?? 0),
    },
    invalid: false,
  }
}
