/**
 * OpenAI-shape graders for `bin/smoke` (`/v1/chat/completions` and `/v1/responses`). A body whose
 * `choices` / `output` shape is wrong is FAIL `malformed-body`; only `choices[0]` is graded and the
 * elements of `tool_calls` are not inspected. A `finish_reason` or `error.message` that cannot be
 * coerced to a string still throws; `driveLeg` catches it and reports FAIL `malformed-body:<error>`. The runner's `driveLeg` wraps every call in a try/catch as a belt-and-braces backstop
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
  // Every element must be a `{type: string}` object; one bad element makes the whole body
  // malformed, the same per-element rule the Messages grader applies to `content`. An empty array
  // stays `no-output` (the documented "the upstream gave us nothing" shape).
  if (rawOutput.length === 0) return fail("no-output")
  const wellFormed = (item: unknown): item is { type: string } =>
    item !== null &&
    typeof item === "object" &&
    typeof (item as { type?: unknown }).type === "string"
  if (!rawOutput.every(wellFormed)) return fail("malformed-body")
  if (!rawOutput.some((item) => item.type === "function_call")) return fail("no-function-call")
  return pass()
}

function openAiErrorMessage(body: unknown): string | undefined {
  const parsed = parseObject(body)
  const message = (parsed as OpenAiChatResponse | OpenAiResponsesResponse | null)?.error?.message
  return message === undefined ? undefined : `error:${message}`
}
