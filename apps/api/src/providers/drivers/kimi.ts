import { createHttpDriver } from "../driver"
import { messageRule, typeRule } from "../failure/classify"

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
 * Provenance: observed live, 2026-07-27 — a plan whose billing cycle is spent answers
 * `403 {"error":{"type":"permission_error","message":"You've reached your usage limit for this
 * billing cycle. Your quota will be refreshed in the next cycle…"}}`.
 *
 * Matched on the wording rather than on `permission_error`, because that type is also Kimi's
 * genuine "this key may not do that" — which *is* an auth failure and must keep falling through
 * to the 403 default.
 *
 * Blast radius, and the reason this rule is not cosmetic: without it the 403 lands on the status
 * default `auth`, and an `api-key` account's auth failure parks at `disabled`
 * (`routing/breaker.ts`, `AUTH_FAILURE_STATUS`) — a state no timer lifts. A cycle that refills on
 * the vendor's clock would need an operator to re-enable a credential that was never broken,
 * which is exactly the `cooling_down`/`exhausted` confusion CLAUDE.md non-negotiable 7 forbids.
 */
const CYCLE_LIMIT = /usage limit for this billing cycle|quota will be refreshed in the next cycle/i

export const kimiDriver = createHttpDriver({
  id: "kimi",
  surfaces: [{ dialect: "anthropic", baseUrl: BASE_URL, anthropicAuth: "vendor-bearer" }],
  rules: [
    typeRule("credits-exhausted", "kimi:exceeded_current_quota_error", QUOTA_TYPES),
    messageRule("credits-exhausted", "kimi:insufficient-balance", INSUFFICIENT_BALANCE),
    // Ahead of the auth rules below: this arrives as a 403 and must never be read as one.
    messageRule("rate-limited", "kimi:billing-cycle-limit", CYCLE_LIMIT),
    typeRule("rate-limited", "kimi:rate_limit_reached_error", RATE_LIMIT_TYPES),
    typeRule("auth", "kimi:invalid_authentication_error", AUTH_TYPES),
    typeRule("server-error", "kimi:engine_overloaded_error", OVERLOAD_TYPES),
  ],
})
