import { z } from "zod"
import { createHttpDriver } from "../driver"
import { type ClassificationRule, typeRule } from "../failure/classify"
import { readErrorFacts } from "../failure/error-body"
import { parseDurationSeconds } from "../rate-limit/duration"
import { parseRateLimitHeaders } from "../rate-limit/parse"
import type { RateLimitSignal, UpstreamErrorFacts, UpstreamResponse } from "../types"

/**
 * `gemini` — Google's Gemini models over their **OpenAI-compatibility surface**, not the native
 * Google GenAI protocol. That scope line is deliberate (docs/idea/10-roadmap.md): a native GenAI
 * dialect is a fourth column in the translation matrix, and the two-dialect matrix earns that first.
 * So this is an ordinary `openai-chat` driver — chat completions, embeddings, and the model listing
 * all land where `services/dataplane/egress/endpoint.ts` addresses them.
 *
 * Own model ids (`gemini-2.5-pro`, `gemini-2.5-flash`), so an Account here usually maps
 * `sonnet` -> `gemini-2.5-flash`. The driver ships no default aliases: an unmapped name passes
 * through untouched.
 *
 * The reason this is more than a base URL: **Google words its failures as canonical gRPC status
 * names rather than OpenAI error codes**, and it reports the retry delay in the body instead of a
 * header. Read only what the shared envelope carries and a Gemini account classifies on its HTTP
 * status alone — which is precisely where `cooling_down` and `exhausted` get conflated.
 */

/**
 * Provenance: Google's OpenAI-compatibility base for the Gemini API — the address a stock OpenAI
 * client is pointed at. It already carries `/v1beta/openai` the way OpenAI's own base carries
 * `/v1`, so `{base}/chat/completions`, `{base}/embeddings`, and `{base}/models` are exactly the
 * URLs the egress layer builds. Blast radius: every `gemini` request. A Vertex or regional endpoint
 * is an Account base-URL override, not a second constant here.
 */
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai"

/**
 * Provenance: `RESOURCE_EXHAUSTED` (HTTP 429) is what Gemini returns for **both** a per-minute
 * request/token limit and a spent free-tier daily allowance. Both refill on a clock, so both are
 * `cooling_down` — never `exhausted`. Blast radius: reading this as a dead balance would park a
 * healthy key at `402`, which no clock would ever undo (CLAUDE.md non-negotiable 7).
 */
const RATE_LIMIT_STATUSES = ["RESOURCE_EXHAUSTED"]

/**
 * Provenance: `UNAUTHENTICATED` (401) is a missing or rejected key; `PERMISSION_DENIED` (403) is a
 * key without access to the API, the project, or the model. Blast radius: both are this Account's
 * own problem, so classifying them as anything retryable would replay a bad credential across the
 * pool instead of naming it.
 */
const AUTH_STATUSES = ["UNAUTHENTICATED", "PERMISSION_DENIED"]

/**
 * Provenance: `INTERNAL` (500), `UNAVAILABLE` (503, the overloaded-model case) and
 * `DEADLINE_EXCEEDED` (504). Blast radius: naming them keeps the recorded signal readable when the
 * compatibility layer or a gateway in front of it relays one under a status that is not its own.
 */
const SERVER_STATUSES = ["INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED"]

/**
 * Provenance: the only Gemini refusals **no clock can fix** — billing never enabled on the project,
 * a billing account that no longer resolves, or a suspended project. They arrive as
 * `FAILED_PRECONDITION` (400) or `PERMISSION_DENIED` (403); Google never answers `402`.
 *
 * Deliberately narrow. Gemini's own *rate-limit* message says "check your plan and billing
 * details", so keying on the word "billing" alone would flip every throttled request to `exhausted`
 * and take a healthy account out of the pool until a human noticed. Blast radius runs both ways,
 * which is why this matches only phrasing a billing stop uses and a throttle never does.
 */
const BILLING_STOPPED =
  /enable billing|requires billing|billing account .{0,64}not found|has been suspended/i

/**
 * Provenance: Google answers a rejected key on this surface with `UNAUTHENTICATED` (401), while the
 * Generative Language API behind it answers a malformed one with `INVALID_ARGUMENT` (400) whose
 * message reads `API key not valid`. Blast radius: without the wording, that second form classifies
 * as a client mistake, so the Account is never flagged and an operator debugs the request instead
 * of the credential.
 */
const BAD_API_KEY = /api key not valid|api_key_invalid|api key expired/i

/**
 * Both wording rules are guarded by an error status, for the same reason the `*-compatible` one is:
 * a completion that happens to contain the phrase must never read as a failure. The billing rule is
 * evaluated **first** — a billing stop wearing a 429 is still permanent, and only a human clears it.
 */
function wordingRule(
  kind: ClassificationRule["kind"],
  signal: string,
  pattern: RegExp,
): ClassificationRule {
  return {
    kind,
    signal,
    when: (facts, status) => status >= 400 && pattern.test(facts.message ?? ""),
  }
}

/**
 * Provenance: Google APIs carry the canonical status name in `error.status` (google.rpc.Code),
 * beside a numeric `error.code` that is just the HTTP status restated. No OpenAI-shaped client
 * reads it, so the shared envelope does not either. Blast radius: without lifting it into `type`,
 * every rule below is dead and Gemini classifies on the status alone.
 */
const GoogleStatus = z.object({ error: z.object({ status: z.string() }) })

/**
 * The shared envelope first — the compatibility layer answers some failures in OpenAI's own shape —
 * then Google's canonical status lifted into `type`, which is where a rule reads a provider's own
 * vocabulary. A body carrying neither yields no facts and falls back to the HTTP status.
 */
function readGeminiFacts(body: unknown): UpstreamErrorFacts {
  const facts = readErrorFacts(body)
  const parsed = GoogleStatus.safeParse(body)
  return parsed.success ? { ...facts, type: parsed.data.error.status } : facts
}

/**
 * Provenance: `google.rpc.RetryInfo`, carried in `error.details[]` as a protobuf Duration
 * (`"31s"`). Gemini sends no `x-ratelimit-*` family and no `Retry-After` header, so this body field
 * is the only reset it ever reports. Blast radius: without it every Gemini 429 has a reset of
 * `unknown` and the breaker backs off on its own guess instead of the provider's number.
 */
const RETRY_INFO_TYPE = "google.rpc.RetryInfo"

const RetryInfo = z.object({ "@type": z.string(), retryDelay: z.string() })
const DetailedError = z.object({ error: z.object({ details: z.array(z.unknown()) }) })

function retryDelaySeconds(body: unknown): number | undefined {
  const parsed = DetailedError.safeParse(body)
  if (!parsed.success) return undefined

  for (const detail of parsed.data.error.details) {
    const info = RetryInfo.safeParse(detail)
    if (!info.success || !info.data["@type"].endsWith(RETRY_INFO_TYPE)) continue
    const seconds = parseDurationSeconds(info.data.retryDelay)
    if (seconds !== null) return seconds
  }
  return undefined
}

function parseGeminiRateLimit(response: UpstreamResponse): RateLimitSignal | null {
  const signal = parseRateLimitHeaders(response)
  // Only a reading that already says "limited" gets the delay attached: `RetryInfo` rides an
  // `UNAVAILABLE` too, where it is a backoff hint about the service and says nothing about this
  // credential's window. A header the provider did send is never overwritten by the body.
  if (signal === null || !signal.limited || signal.retryAfterSeconds !== undefined) return signal

  const seconds = retryDelaySeconds(response.body)
  if (seconds === undefined) return signal

  return { ...signal, retryAfterSeconds: seconds, resetSource: "provider-reported" }
}

export const geminiDriver = createHttpDriver({
  id: "gemini",
  surfaces: [{ dialect: "openai-chat", baseUrl: BASE_URL }],
  readFacts: readGeminiFacts,
  parseRateLimit: parseGeminiRateLimit,
  rules: [
    wordingRule("credits-exhausted", "gemini:billing-stopped", BILLING_STOPPED),
    typeRule("rate-limited", "gemini:RESOURCE_EXHAUSTED", RATE_LIMIT_STATUSES),
    typeRule("auth", "gemini:auth-status", AUTH_STATUSES),
    wordingRule("auth", "gemini:api-key-invalid", BAD_API_KEY),
    typeRule("server-error", "gemini:server-status", SERVER_STATUSES),
  ],
})
