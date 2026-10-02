import { createHttpDriver } from "../driver"
import { messageRule, typeRule, withResetEstimate } from "../failure/classify"

/**
 * `kimi` — Anthropic-shaped coding surface, prepaid balance, own model ids (`k3`). An Account
 * here typically maps `sonnet` -> `k3`; unmapped names pass through.
 *
 * Auth is verified: the operator drives this endpoint with Claude Code's `ANTHROPIC_AUTH_TOKEN`,
 * so the key goes on `Authorization: Bearer` with `anthropic-version` — never `x-api-key`, and
 * never the Anthropic OAuth beta, which a vendor key has nothing to do with.
 */

/** Provenance: docs/idea/03-providers.md registry table. Blast radius: every `kimi` request. */
const BASE_URL = "https://api.kimi.com/coding"

/**
 * Provenance: Moonshot/Kimi's published error `type` vocabulary, carried in an Anthropic-shaped
 * `error.type`. `exceeded_current_quota_error` is the drained-balance case and is the reason this
 * driver exists as more than a base URL. Blast radius: without it the account cools down on a
 * timer instead of being flagged `exhausted` for a human to top up.
 */
const QUOTA_TYPES = ["exceeded_current_quota_error"]
const RATE_LIMIT_TYPES = ["rate_limit_reached_error"]
const AUTH_TYPES = ["invalid_authentication_error", "authentication_error"]
const OVERLOAD_TYPES = ["engine_overloaded_error"]

const INSUFFICIENT_BALANCE = /insufficient balance|balance is insufficient|account.*not active/i

/**
 * Kimi's plan limits, all of them announced as `403 {"error":{"type":"permission_error",…}}`.
 *
 * Provenance, three phrasings observed live, measured by the developerz.ai platform over four days
 * to 2026-08-29 (314 bodies) and confirmed in this router's own production log on 2026-10-02:
 *
 * | Window | Opening clause | Seen |
 * |---|---|---|
 * | weekly | "You've reached your weekly (7-day) usage limit." | 238 |
 * | 5-hour | "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends." | 52 |
 * | billing cycle | "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle." | 24 |
 *
 * Matched on the wording rather than on `permission_error`, because that type is also Kimi's
 * genuine "this key may not do that" ("You do not have access to model k3-preview") — which *is* an
 * auth failure and must keep falling through to the 403 default. And matched on the *property* —
 * a limit `reached`, or a quota that `will reset` / `will be refreshed` — rather than on one
 * sentence: through 2.14.0 only the billing-cycle sentence was known, the 5-hour one fell to `auth`,
 * and an account Kimi reopens on its own clock sat out of rotation until a human noticed (prod,
 * 2026-10-02 02:18Z). `reached` within one clause of `usage limit` is what separates hitting a limit
 * from describing one ("your usage limit is 1,000 rpm"), in either order ("usage limit reached", "your
 * usage limit has been reached"). Never anchored on "You've": a copy-edited body may carry a curly
 * apostrophe. A body that also says the account was suspended is never one of these — see
 * `ACCOUNT_SUSPENDED`, which is read first.
 *
 * Blast radius: every Kimi `403` whose message reports a reached limit. Read wrongly as `auth`, an
 * `api-key` account cools down as `credential-rejected` and is re-tested only after
 * `ROUTING_AUTH_FAILURE_COOLDOWN_MS` (`routing/breaker.ts`), and the pool reports it as needing a
 * human.
 */
const WEEKLY_LIMIT =
  /reached[^.]{0,40}\b(?:weekly|7-day)\b[^.]{0,20}usage limit|\b(?:weekly|7-day)\b[^.]{0,20}usage limit[^.]{0,20}\breached\b/i
const FIVE_HOUR_LIMIT =
  /reached[^.]{0,40}\b5-hour\b[^.]{0,20}usage limit|\b5-hour\b[^.]{0,20}usage limit[^.]{0,20}\breached\b/i
const CYCLE_LIMIT = /usage limit for this billing cycle|quota will be refreshed in the next cycle/i
const ANY_USAGE_LIMIT =
  /reached[^.]{0,40}usage limit|usage limit[^.]{0,20}\breached\b|quota will (?:be refreshed|reset)/i

/**
 * The account itself was taken away, whatever else the body says. A limit clause beside this
 * ("…reached its usage limit and has been suspended for violating terms of service") is not a
 * window a clock reopens, so this is read first and lands on `auth`: reported as needing a human,
 * re-tested only on the long credential cadence. Provenance: review of #139 (2026-10-02) — no such
 * Kimi body has been observed; the guard exists so the family regexes above cannot ever read one as
 * a spent window. Blast radius: a Kimi `403` naming a suspension, ban, deactivation, terms
 * violation or a disabled account/key — it stays `auth` instead of becoming a short cooldown.
 */
const ACCOUNT_SUSPENDED =
  /\b(?:suspend(?:ed|sion)|banned|deactivated|terminated|terms of (?:service|use)|violat(?:ed|ing|ion))\b|\b(?:account|key)\b[^.]{0,30}\bdisabled\b/i

/**
 * How long to assume each limit lasts. Kimi names no instant — "when the current 5-hour window
 * ends" — and sends no rate-limit headers, so the reset is ours and travels labeled `estimated`.
 * These are re-test cadences, not predictions: short enough that a window which reopened early is
 * found within minutes, long enough that one probe per interval is all a still-spent key costs.
 * Provenance: chosen 2026-10-02 against the windows above. Blast radius: how soon a spent Kimi
 * account is re-tested, and the "earliest reset" a caller is told.
 */
const FIVE_HOUR_RETEST_SECONDS = 15 * 60
const LONG_WINDOW_RETEST_SECONDS = 60 * 60

export const kimiDriver = createHttpDriver({
  id: "kimi",
  surfaces: [{ dialect: "anthropic", baseUrl: BASE_URL, anthropicAuth: "vendor-bearer" }],
  rules: [
    typeRule("credits-exhausted", "kimi:exceeded_current_quota_error", QUOTA_TYPES),
    messageRule("credits-exhausted", "kimi:insufficient-balance", INSUFFICIENT_BALANCE),
    // Ahead of every limit rule: a suspension that also mentions a limit is still a suspension.
    messageRule("auth", "kimi:account-suspended", ACCOUNT_SUSPENDED),
    // Ahead of the auth rules below: these arrive as a 403 and must never be read as one. The
    // specific windows first, so each carries its own signal and re-test cadence; the family last,
    // for a window Kimi has not shipped yet.
    withResetEstimate(
      messageRule("rate-limited", "kimi:billing-cycle-limit", CYCLE_LIMIT),
      LONG_WINDOW_RETEST_SECONDS,
    ),
    withResetEstimate(
      messageRule("rate-limited", "kimi:usage-limit-weekly", WEEKLY_LIMIT),
      LONG_WINDOW_RETEST_SECONDS,
    ),
    withResetEstimate(
      messageRule("rate-limited", "kimi:usage-limit-5-hour", FIVE_HOUR_LIMIT),
      FIVE_HOUR_RETEST_SECONDS,
    ),
    withResetEstimate(
      messageRule("rate-limited", "kimi:usage-limit", ANY_USAGE_LIMIT),
      FIVE_HOUR_RETEST_SECONDS,
    ),
    typeRule("rate-limited", "kimi:rate_limit_reached_error", RATE_LIMIT_TYPES),
    typeRule("auth", "kimi:invalid_authentication_error", AUTH_TYPES),
    typeRule("server-error", "kimi:engine_overloaded_error", OVERLOAD_TYPES),
  ],
})
