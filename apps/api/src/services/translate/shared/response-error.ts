import type { Dialect } from "@multi-ai-router/core"
import { translateUpstreamError } from "./errors"
import type { TranslatedResponse } from "./response"

/** Match the upstream terminal observer's structural error criteria without inventing HTTP status. */
export function translatedResponseError(
  body: unknown,
  ingress: Dialect,
  egress: Dialect,
): TranslatedResponse | null {
  const payload = object(body)
  if (!payload) return null
  const recognized =
    egress === "openai-chat"
      ? object(payload.error) !== null
      : egress === "anthropic"
        ? payload.type === "error" && object(payload.error) !== null
        : payload.type === "error" ||
          payload.type === "response.failed" ||
          payload.status === "failed"
  if (!recognized) return null
  // 502 selects the ingress server-error vocabulary only; the caller keeps the received HTTP status.
  return { body: translateUpstreamError(body, 502, ingress), unrecognizedStopReason: null }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
