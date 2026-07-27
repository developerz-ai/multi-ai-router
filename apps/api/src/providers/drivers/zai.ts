import { createHttpDriver } from "../driver"
import { codeRule, messageRule } from "../failure/classify"
import { readErrorFacts } from "../failure/error-body"
import { parseInstant } from "../rate-limit/duration"
import { parseRateLimitHeaders } from "../rate-limit/parse"
import type { RateLimitSignal, UpstreamResponse } from "../types"

/**
 * `zai` — two compatible surfaces, and the Account picks one. The choice decides the endpoint
 * *and* the auth header form, so both live on the surface. Either way the key travels as
 * `Authorization: Bearer`; the Anthropic surface adds `anthropic-version` and nothing else.
 *
 * Prepaid balance, own model ids (`glm-5.2`, `glm-4.7`) — an Account here usually maps
 * `sonnet` -> `glm-4.7` in its alias map. The driver ships no default aliases: a name the
 * operator did not map passes through untouched.
 */

/**
 * Provenance: docs/idea/03-providers.md registry table. Anthropic is the default surface because
 * the primary client (Claude Code) speaks it, so an Account that states no preference passes
 * through rather than translating. Blast radius: every `zai` request.
 */
const ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic"
const OPENAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4"

/**
 * Provenance: z.ai / GLM numeric error codes, returned as `error.code` on both surfaces —
 * `1113` is a drained balance, the `130x` family is throttling, the `100x` family is auth.
 * Blast radius: without `1113` a dead balance reads as a generic `400` and the account is never
 * marked `exhausted`. Expect drift; this is the one file to fix when it happens.
 */
const BALANCE_CODES = ["1113", "1112"]
const THROTTLE_CODES = ["1302", "1303", "1304", "1305"]
const AUTH_CODES = ["1000", "1001", "1002", "1003", "1004"]

/**
 * Provenance: observed live, 2026-07-27 — a coding plan whose window is spent answers
 * `429 {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at
 * 2026-08-01 10:03:40"}}` on both surfaces.
 *
 * `rate-limited`, not `credits-exhausted`: the plan states its own reset, so a clock revives it and
 * CLAUDE.md non-negotiable 7 puts it in `cooling_down`. Blast radius of losing this code is only
 * the signal's provenance — a 429 already defaults to `rate-limited` — but the reset instant it
 * carries is not recoverable any other way; see {@link parseZaiReset}.
 */
const WINDOW_CODES = ["1310"]

const INSUFFICIENT_BALANCE = /insufficient balance|balance is insufficient|account balance/i

/**
 * z.ai reports a plan window's reset **only in the error message**, never in a header — the 429
 * carries no `retry-after` and no `x-ratelimit-*` at all (verified against the live endpoint).
 *
 * Without this, `parseRateLimitHeaders` yields `resetSource: "unknown"`, the breaker falls back to
 * its exponential backoff, and that backoff is capped at `DEFAULT_MAX_BACKOFF_MS` (5 minutes). A
 * *weekly* window would therefore be re-probed every five minutes for days — thousands of requests
 * upstream to relearn a fact z.ai stated exactly once.
 */
const RESET_AT = /reset at\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/i

/**
 * The stamp carries no offset. It is **UTC+8**, established by comparing z.ai's own request-id
 * prefix (`202607280616…`) against the UTC instant the response was received (2026-07-27 22:16Z) —
 * an eight-hour lead, i.e. Asia/Shanghai, where Zhipu operates.
 *
 * Blast radius if they ever move to UTC: the router waits eight hours longer than it must before
 * probing. That direction is deliberate on a guess — reading the stamp as UTC when it is in fact
 * UTC+8 would park a *recovered* account for eight extra hours, whereas probing early costs one
 * more 429 — but it is not a guess here, and this is the one line to change if it drifts.
 */
const ZAI_UTC_OFFSET = "+08:00"

/** The reset instant z.ai buries in its message, or `null` when it stated none. */
export function parseZaiReset(body: unknown): Date | null {
  const { message } = readErrorFacts(body)
  if (message === undefined) return null
  const match = RESET_AT.exec(message)
  if (!match?.[1] || !match[2]) return null
  return parseInstant(`${match[1]}T${match[2]}${ZAI_UTC_OFFSET}`)
}

/**
 * Headers first — z.ai may start sending them, and they win nothing by being ignored — then the
 * message-borne reset folded in on top. A window z.ai named is a window it is enforcing *now*, so
 * the reading is `limited` and `provider-reported`, not an estimate of ours.
 */
function parseZaiRateLimit(response: UpstreamResponse): RateLimitSignal | null {
  const fromHeaders = parseRateLimitHeaders(response)
  const resetsAt = parseZaiReset(response.body)
  if (resetsAt === null) return fromHeaders

  return {
    ...fromHeaders,
    limited: true,
    resetsAt,
    resetSource: "provider-reported",
    windows: [
      ...(fromHeaders?.windows ?? []),
      {
        // z.ai's own word for it, kept rather than mapped: the plan is sold as a weekly/monthly
        // allowance and the console should say what the operator bought.
        limiter: "weekly-monthly",
        utilization: 1,
        // The plan is silent until the moment it is spent — there is no headroom reading to take
        // between one 429 and the next.
        utilizationSource: "threshold-triggered",
        resetsAt,
        resetSource: "provider-reported",
      },
    ],
  }
}

export const zaiDriver = createHttpDriver({
  id: "zai",
  surfaces: [
    // Verified: the operator drives this endpoint with Claude Code's `ANTHROPIC_AUTH_TOKEN`,
    // i.e. `Authorization: Bearer`. Blast radius of `x-api-key` here: an unexpected header a
    // vendor may reject or log.
    { dialect: "anthropic", baseUrl: ANTHROPIC_BASE_URL, anthropicAuth: "vendor-bearer" },
    { dialect: "openai-chat", baseUrl: OPENAI_BASE_URL },
  ],
  parseRateLimit: parseZaiRateLimit,
  rules: [
    codeRule("credits-exhausted", "zai:balance-code", BALANCE_CODES),
    messageRule("credits-exhausted", "zai:insufficient-balance", INSUFFICIENT_BALANCE),
    codeRule("rate-limited", "zai:throttle-code", THROTTLE_CODES),
    codeRule("rate-limited", "zai:window-exhausted", WINDOW_CODES),
    codeRule("auth", "zai:auth-code", AUTH_CODES),
  ],
})
