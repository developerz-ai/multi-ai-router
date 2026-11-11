import { type ClassificationRule, messageRule, typeRule } from "../failure/classify"

/**
 * The vocabulary both OpenCode drivers share — Go's per-member keys (`opencode-go.ts`) and the
 * Console login (`opencode-oauth.ts`) reach one inference backend, so it answers both in the same
 * words. One file, so a drift in OpenCode's wording is fixed once: a rename of `FreeUsageLimitError`
 * fixed in one driver and not the other would cool the other's seats as plain `429`s.
 */

/**
 * Provenance: measured 2026-11-06 — a request without it answers `400 MissingSessionID` on every
 * surface, streaming included; the Console surface takes the same header (MITM 2026-11-07). Blast
 * radius: losing it fails every request, on every account of both drivers.
 */
export const OPENCODE_SESSION_HEADER = "x-opencode-session"

/**
 * Provenance: the Go docs ask a client for its own user agent, not a generic HTTP library's, and
 * state that traffic is monitored. This is ours, stated honestly; the upstream accepted it on every
 * Go surface on 2026-11-06 and on the Console catalog and free-limit response on 2026-11-07. Blast
 * radius: requests read as an unidentified library.
 */
export const OPENCODE_USER_AGENT = "developerz.ai"

/**
 * OpenCode's shared inference backend is full, not the member's quota window.
 * Provenance: Go production 2026-11-07: `[overloaded] the server is overloaded` at 00:22–01:56Z,
 * then `[prefill_cap_refused] the cell is at capacity; retry shortly (after 30 s)` at 14:56,
 * 15:06 and 15:07Z. The latter fell through to the 429 default and cooled an otherwise usable
 * seat, causing subsequent requests to be refused without reaching upstream.
 *
 * Match its explicit tags (plus the older overload sentence), never generic "capacity" or "limit":
 * `Go usage limit exceeded` and `FreeUsageLimitError` remain actual rate limits. Blast radius:
 * matched failures retry with the existing overload budget, never cool the account, and become 503
 * rather than quota_exhausted. Read on the throttle and server statuses only — a `400` echoing a
 * model name is not the backend.
 */
export const OPENCODE_OVERLOADED = /\[(?:overloaded|prefill_cap_refused)\]|server is overloaded/i
const OVERLOADED_STATUSES = [429, 500, 502, 503, 504, 529]

/**
 * Provenance: bodies observed live on Go, 2026-11-06, with a key holding no pay-as-you-go balance.
 *
 * - `402 Insufficient account funds` is the status default's verdict too; the rule only names it.
 *   Unobserved: what a spent plan window answers with Extra Usage on and no balance. If that is this
 *   same `402`, a clock-recoverable window lands in `exhausted` and needs an operator — check the
 *   first real one against docs/idea/03-providers.md.
 * - `FreeUsageLimitError` is a `429` with a real `Retry-After`, so a clock revives it.
 * - `Model is unavailable` is a `400` for a name this plan does not serve: the next account may.
 */
const FREE_LIMIT_TYPES = ["FreeUsageLimitError"]
const NO_FUNDS = /insufficient account funds/i
const MODEL_UNAVAILABLE = /model is unavailable/i

/** The shared rules, in order, each signal prefixed with the driver's own name. */
export function opencodeRules(prefix: string): readonly ClassificationRule[] {
  return [
    messageRule("overloaded", `${prefix}:overloaded`, OPENCODE_OVERLOADED, {
      statuses: OVERLOADED_STATUSES,
    }),
    typeRule("rate-limited", `${prefix}:free-usage-limit`, FREE_LIMIT_TYPES),
    messageRule("credits-exhausted", `${prefix}:insufficient-funds`, NO_FUNDS, { statuses: [402] }),
    messageRule("model-unsupported", `${prefix}:model-unavailable`, MODEL_UNAVAILABLE, {
      statuses: [400, 404],
    }),
  ]
}
