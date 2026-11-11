/**
 * A fast-transport failure after preparation: DNS, TLS, a reset, a stalled upstream (101 finding
 * 05.7). The message stays the router's own sentence — it is what the classifier and the client
 * see — and `cause` keeps the original for whoever inspects the error in-process. `reason` is the
 * one field fit for a log line: an error name or errno code, never a message that could quote a
 * header, a URL or a body.
 */
export class FastTransportError extends Error {
  readonly reason: string
  constructor(cause: unknown) {
    super("Claude direct HTTP request failed", { cause })
    this.name = "FastTransportError"
    this.reason = failureReason(cause)
  }
}

/** `ECONNRESET`, `TimeoutError`, `ZodError` … — a class or code, never free text. */
export function failureReason(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)) return code
    return /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error"
  }
  return typeof error
}
