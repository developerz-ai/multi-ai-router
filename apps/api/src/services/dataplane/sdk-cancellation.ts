import { UpstreamTimeoutError } from "@multi-ai-router/core"

/** Attribute abort-shaped SDK errors to the first composed-signal cause, not a later bit. */
export function sdkCancellation(
  error: unknown,
  attempt: AbortSignal,
  caller: AbortSignal | undefined,
): "caller" | "deadline" | undefined {
  const name = error instanceof Error ? error.name : ""
  const abortShaped = name === "AbortError" || name === "TimeoutError"
  const exactReason = attempt.aborted && error === attempt.reason
  if (!abortShaped && !exactReason && !(error instanceof UpstreamTimeoutError)) return undefined
  if (attempt.aborted) {
    return caller?.aborted && attempt.reason === caller.reason ? "caller" : "deadline"
  }
  return "deadline"
}
