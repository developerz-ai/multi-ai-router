import type { Dialect } from "@multi-ai-router/core"
import { translateUpstreamError } from "./errors"
import { isRecord } from "./is-record"
import type { TranslatedResponse } from "./response"

/** Match the upstream terminal observer's structural error criteria without inventing HTTP status. */
export function translatedResponseError(
  body: unknown,
  ingress: Dialect,
  egress: Dialect,
): TranslatedResponse | null {
  const payload = isRecord(body) ? body : null
  if (!payload) return null
  const recognized =
    egress === "openai-chat"
      ? carriesOpenAiChatError(payload)
      : egress === "anthropic"
        ? payload.type === "error" && isRecord(payload.error)
        : payload.type === "error" ||
          payload.type === "response.failed" ||
          payload.status === "failed"
  if (!recognized) return null
  // 502 selects the ingress server-error vocabulary only; the caller keeps the received HTTP status.
  return { body: translateUpstreamError(body, 502, ingress), unrecognizedStopReason: null }
}

/**
 * Whether an openai-chat body or chunk states an upstream failure: an `error` member that is an
 * object or a string. `"error": null` is a compatible vendor stating "no error" beside real content,
 * so it is not one — `"error" in payload` would end a healthy stream.
 */
export function carriesOpenAiChatError(payload: Readonly<Record<string, unknown>>): boolean {
  const error = payload.error
  return isRecord(error) || typeof error === "string"
}
