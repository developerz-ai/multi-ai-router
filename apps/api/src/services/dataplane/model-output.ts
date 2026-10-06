import type { Dialect } from "@multi-ai-router/core"
import type { ResponseObservationDescriptor } from "../../providers/types"
import { responseObject } from "../usage/response-usage"

const CHAT_DELTA_TEXT = ["content", "reasoning_content", "reasoning", "refusal"] as const

/**
 * Whether one parsed upstream frame carries words the model produced — a content, thinking, or
 * tool-argument delta. Envelope frames (`message_start`, `ping`, a role-only chat delta) do not
 * count: the Agent-SDK path synthesizes those before the model has said anything, so relayed bytes
 * alone are not proof the account served.
 */
export function isModelOutputFrame(
  dialect: Dialect,
  payload: unknown,
  event: string | undefined,
): boolean {
  const root = responseObject(payload)
  const type = root?.type ?? event
  if (dialect === "anthropic") return type === "content_block_delta"
  if (dialect === "openai-responses")
    return typeof type === "string" && type.startsWith("response.") && type.endsWith(".delta")
  const choices = root?.choices
  if (!Array.isArray(choices)) return false
  return choices.some((choice) => {
    const delta = responseObject(responseObject(choice)?.delta)
    if (delta === undefined) return false
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true
    return CHAT_DELTA_TEXT.some((key) => {
      const value = delta[key]
      return typeof value === "string" && value.length > 0
    })
  })
}

/**
 * Wraps a driver's observation descriptor so the observer's existing frame parse also reports model
 * output — no second pass over the stream. Absent a driver descriptor, `evidence-only` is the same
 * policy the observer applies to none.
 */
export function observingModelOutput(
  dialect: Dialect,
  descriptor: ResponseObservationDescriptor | undefined,
  onOutput: () => void,
): ResponseObservationDescriptor {
  const inspect = descriptor?.inspectPayload
  return {
    terminalPolicy: descriptor?.terminalPolicy ?? "evidence-only",
    inspectPayload: (payload, event) => {
      if (isModelOutputFrame(dialect, payload, event)) onOutput()
      return inspect === undefined ? null : inspect(payload, event)
    },
  }
}
