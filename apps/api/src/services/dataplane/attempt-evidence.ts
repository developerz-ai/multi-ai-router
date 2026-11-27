import { redactValue } from "../../logging/redact"

/**
 * What an attempt's failure line carries beyond its verdict (#509): the evidence that tells a real
 * at-once limit from a wrapper problem. Every field is absent where it does not apply, never null.
 */
export interface AttemptEvidence {
  /** Requests in flight on the account when the refusal landed, the refused one included. */
  readonly inFlight?: number
  /** Claude only: the invoker that produced the outcome. */
  readonly transport?: "fast" | "sdk"
  /** The model name sent upstream on this attempt. */
  readonly model?: string
  /** Claude only: the scrub rules that changed the system prompt sent. */
  readonly scrubRules?: readonly string[]
  /** The upstream's own response headers, where the transport still holds them. */
  readonly headers?: Headers
}

/** The log fields of an attempt's evidence: header values pass `redactValue`, as every value does. */
export function evidenceFields(evidence: AttemptEvidence | undefined): Record<string, unknown> {
  if (evidence === undefined) return {}
  const { headers } = evidence
  const requestId = headers?.get("request-id") ?? headers?.get("x-request-id") ?? null
  const retryAfter = headers?.get("retry-after") ?? null
  const rateLimitHeaders = headers === undefined ? undefined : rateLimitHeadersOf(headers)
  return {
    ...(evidence.inFlight === undefined ? {} : { inFlight: evidence.inFlight }),
    ...(evidence.transport === undefined ? {} : { transport: evidence.transport }),
    ...(evidence.model === undefined ? {} : { model: evidence.model }),
    ...(evidence.scrubRules === undefined ? {} : { scrubRules: evidence.scrubRules }),
    ...(requestId === null ? {} : { upstreamRequestId: redactValue(requestId) }),
    ...(retryAfter === null ? {} : { retryAfter: redactValue(retryAfter) }),
    ...(rateLimitHeaders === undefined ? {} : { rateLimitHeaders }),
  }
}

/**
 * Every header naming a rate limit (`anthropic-ratelimit-*`, `x-ratelimit-*`), plus Codex's usage
 * windows (`x-codex-primary-*`, `x-codex-secondary-*`, `drivers/openai-oauth-quota.ts`). Names are
 * lower-cased by `Headers`. A tokens-limiter key names `token`, so the logger redacts its value:
 * accepted, the requests limiter and the unified windows keep theirs. Undefined when none match.
 */
function rateLimitHeadersOf(headers: Headers): Record<string, string> | undefined {
  const matched: Record<string, string> = {}
  let any = false
  for (const [name, value] of headers) {
    if (!RATE_LIMIT_HEADER.test(name)) continue
    matched[name] = redactValue(value)
    any = true
  }
  return any ? matched : undefined
}

const RATE_LIMIT_HEADER = /ratelimit|^x-codex-(?:primary|secondary)-/
