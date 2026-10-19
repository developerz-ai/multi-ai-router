import { UpstreamTimeoutError } from "@multi-ai-router/core"
import { isSdkAbortEcho } from "../../providers"

/** Attribute abort-shaped SDK errors to the first composed-signal cause, not a later bit. */
export function sdkCancellation(
  error: unknown,
  attempt: AbortSignal,
  caller: AbortSignal | undefined,
): "caller" | "deadline" | undefined {
  const name = error instanceof Error ? error.name : ""
  const abortShaped = name === "AbortError" || name === "TimeoutError"
  const exactReason = attempt.aborted && error === attempt.reason
  // The SDK answers an abort of its launch controller with its own plain-Error echo rather than
  // the signal's reason (`providers/claude-sdk/errors.ts`: `isSdkAbortEcho`). Trusted only while
  // the composed signal is actually aborted: the same wording with a live signal is the SDK
  // aborting on its own, which stays an upstream error (#297).
  const echoedAbort = attempt.aborted && isSdkAbortEcho(error)
  if (!abortShaped && !exactReason && !echoedAbort && !(error instanceof UpstreamTimeoutError))
    return undefined
  if (attempt.aborted) {
    return caller?.aborted && attempt.reason === caller.reason ? "caller" : "deadline"
  }
  return "deadline"
}
