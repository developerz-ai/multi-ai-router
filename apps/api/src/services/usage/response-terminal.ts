import type { Dialect } from "@multi-ai-router/core"
import type { FailureClassification } from "../../providers/types"
import type { ResponseObservationFacts } from "./response-observer-types"
import { responseObject } from "./response-usage"

export function protocolFailure(signal: string): FailureClassification {
  return { kind: "server-error", status: 200, retryable: true, signal, rateLimit: null }
}
export function readResponseTerminal(
  dialect: Dialect,
  body: unknown,
  event: string | undefined,
): Pick<ResponseObservationFacts, "terminal" | "failure" | "incompleteReason"> {
  const payload = responseObject(body)
  const type = payload?.type ?? event
  const empty = { terminal: "none", failure: null, incompleteReason: null } as const
  if (!payload) return empty
  const topError = responseObject(payload.error)
  if (
    (dialect === "openai-chat" && topError !== undefined) ||
    (dialect === "anthropic" && type === "error" && topError !== undefined) ||
    (dialect === "openai-responses" && (type === "response.failed" || type === "error"))
  )
    return {
      terminal: "explicit_error",
      failure: protocolFailure("protocol:explicit-error"),
      incompleteReason: null,
    }
  if (dialect === "anthropic" && type === "message_stop") return { ...empty, terminal: "completed" }
  if (dialect === "openai-responses") {
    const response = responseObject(payload.response) ?? payload
    const status = response.status
    if (type === "response.failed" || status === "failed")
      return {
        terminal: "explicit_error",
        failure: protocolFailure("protocol:response-failed"),
        incompleteReason: null,
      }
    if (type === "response.incomplete" || status === "incomplete") {
      const reason = responseObject(response.incomplete_details)?.reason
      return {
        terminal: "explicit_incomplete",
        failure: null,
        incompleteReason:
          reason === "max_output_tokens" || reason === "content_filter" ? reason : "unknown",
      }
    }
    if (type === "response.completed" || status === "completed")
      return { ...empty, terminal: "completed" }
  }
  return empty
}
