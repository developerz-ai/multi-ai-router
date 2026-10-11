/**
 * OpenAI-shape graders for `bin/smoke` (`/v1/chat/completions` and `/v1/responses`). Total: a body
 * that does not match the documented shape is FAIL `malformed-body`, not a throw that escapes the
 * runner. The runner's `driveLeg` wraps every call in a try/catch as a belt-and-braces backstop
 * against anything the type guards below let through (a body whose `stop_reason` is a
 * non-coercible object, used in a template literal, still throws).
 */

import type { LegOutcome } from "./grade"
import { fail, parseObject, pass } from "./grade"

interface OpenAiChatResponse {
  readonly choices?: unknown
  readonly error?: { readonly message?: string }
}

interface OpenAiResponsesResponse {
  readonly output?: unknown
  readonly error?: { readonly message?: string }
}

export function gradeChatCompletions(status: number, body: unknown): LegOutcome {
  if (status !== 200) return fail(`http-${status}`, openAiErrorMessage(body))
  const parsed = parseObject(body)
  if (parsed === null) return fail("unparsable-body")
  const choices = parsed.choices
  if (!Array.isArray(choices)) return fail("malformed-body")
  const choice = choices[0]
  if (choice === undefined) return fail("no-choice")
  if (choice === null || typeof choice !== "object") return fail("malformed-body")
  const finishReason = (choice as { finish_reason?: unknown }).finish_reason
  if (finishReason !== "tool_calls") {
    return fail(`finish-${finishReason === undefined ? "none" : String(finishReason)}`)
  }
  const message = (choice as { message?: { tool_calls?: unknown } }).message
  const toolCalls = message?.tool_calls
  // `tool_calls: null` (or any non-array) is a malformed body; `tool_calls` missing or `[]` is the
  // router's "did not call the tool" answer. The two cases were conflated before and either path
  // would throw today on `toolCalls.length`.
  if (toolCalls !== undefined && !Array.isArray(toolCalls)) return fail("malformed-body")
  if (toolCalls === undefined || toolCalls.length === 0) return fail("no-tool-calls")
  return pass()
}

export function gradeResponses(status: number, body: unknown): LegOutcome {
  if (status !== 200) return fail(`http-${status}`, openAiErrorMessage(body))
  const parsed = parseObject(body)
  if (parsed === null) return fail("unparsable-body")
  const rawOutput = parsed.output
  if (!Array.isArray(rawOutput)) return fail("malformed-body")
  // Filter out null and non-object items: an array of nulls, an array of strings, or anything else
  // that is not a `{type:string}` object is FAIL `malformed-body`. An empty array stays as
  // `no-output` (the documented "the upstream gave us nothing" shape).
  if (rawOutput.length === 0) return fail("no-output")
  const items = rawOutput.filter(
    (item): item is { type: string } =>
      item !== null &&
      typeof item === "object" &&
      typeof (item as { type?: unknown }).type === "string",
  )
  if (items.length === 0) return fail("malformed-body")
  if (!items.some((item) => item.type === "function_call")) return fail("no-function-call")
  return pass()
}

function openAiErrorMessage(body: unknown): string | undefined {
  const parsed = parseObject(body)
  const message = (parsed as OpenAiChatResponse | OpenAiResponsesResponse | null)?.error?.message
  return message === undefined ? undefined : `error:${message}`
}
