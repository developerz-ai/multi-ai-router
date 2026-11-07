import { createHttpDriver } from "../driver"
import { messageRule, typeRule } from "../failure/classify"
import type { ProviderDriver } from "../types"
import { opencodeGoQuotaRead } from "./opencode-go-quota"
import { opencodeModelListing } from "./opencode-models"

/**
 * `opencode-go` — OpenCode's flat-fee Go plan, one API key per team member. An ordinary key: no
 * login, and nothing here presents the router as OpenCode's own client.
 *
 * Every model answers on all three surfaces (the upstream translates), so the Account's surface is
 * chosen for the clients it serves: a same-dialect request is then a byte relay. Chat is the default
 * because it is the surface the upstream's own catalog names for this plan.
 *
 * Provenance: opencode.ai/v2/docs/console/go, and every surface below driven live with a real key on
 * 2026-11-06. Blast radius: every `opencode-go` request.
 */
const BASE_URL = "https://opencode.ai/inference/go"

/**
 * Provenance: measured 2026-11-06 — a request without it answers `400 MissingSessionID` on every
 * surface, streaming included. Blast radius: losing it fails every request, on every account.
 */
const SESSION_HEADER = "x-opencode-session"

/**
 * Provenance: the Go docs ask a client for its own user agent, not a generic HTTP library's, and
 * state that traffic is monitored. This is ours, stated honestly; the upstream accepted it on every
 * surface on 2026-11-06. Blast radius: requests read as an unidentified library.
 */
const USER_AGENT = "developerz.ai"

/**
 * Provenance: bodies observed live, 2026-11-06, with a key holding no pay-as-you-go balance.
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

/**
 * Provenance: prod 2026-11-07 00:22..01:56Z, 199 failed requests across both Go seats: `429` with
 * `Upstream request failed: [overloaded] the server is overloaded; retry shortly`. Go's shared
 * backend being busy, not this seat's limit — which Go words differently (`Go usage limit
 * exceeded`, `FreeUsageLimitError`). Read as `rate-limited` it cooled both seats, spent their
 * recovery permits and answered `429 quota_exhausted` with nobody out of anything. Matched first,
 * on the bracketed tag Go stamps on relayed upstream errors or the sentence itself. Blast radius:
 * a body matched here is retried with backoff and never cools the seat.
 */
const OVERLOADED = /\[overloaded\]|server is overloaded/i

/**
 * Provenance: Go relays MiniMax's own refusal, driven live on the anthropic surface 2026-11-06:
 * `thinking: {type: "disabled"}` answers `400 … model "minimax-m3.1-flash" requires adaptive
 * thinking … (2013)`; no `thinking`, `output_config.effort` `low` or `max`, and `adaptive` + `low`
 * all answer `200` with the forced tool. Go's listing states `effort: [low … max]` and no `toggle`
 * for it. Blast radius: a forced tool or `reasoning_effort: none` on this model, translated or not.
 */
const THINKING_REQUIRED_MODELS = /^minimax-m3\.1-flash(?:-|$)/i

const driver = createHttpDriver({
  id: "opencode-go",
  billing: "subscription",
  surfaces: [
    { dialect: "openai-chat", baseUrl: `${BASE_URL}/openai/v1`, sessionHeader: SESSION_HEADER },
    {
      dialect: "anthropic",
      baseUrl: `${BASE_URL}/anthropic`,
      anthropicAuth: "vendor-bearer",
      sessionHeader: SESSION_HEADER,
      thinkingRequiredModels: THINKING_REQUIRED_MODELS,
    },
    {
      dialect: "openai-responses",
      baseUrl: `${BASE_URL}/openai/v1`,
      sessionHeader: SESSION_HEADER,
    },
  ],
  rules: [
    messageRule("overloaded", "opencode-go:overloaded", OVERLOADED),
    typeRule("rate-limited", "opencode-go:free-usage-limit", FREE_LIMIT_TYPES),
    messageRule("credits-exhausted", "opencode-go:insufficient-funds", NO_FUNDS),
    messageRule("model-unsupported", "opencode-go:model-unavailable", MODEL_UNAVAILABLE),
  ],
})

export const opencodeGoDriver: ProviderDriver = {
  ...driver,
  modelListing: opencodeModelListing,
  quotaRead: opencodeGoQuotaRead,
  buildHeaders: (account, credential) => {
    const headers = driver.buildHeaders(account, credential)
    headers.set("user-agent", USER_AGENT)
    return headers
  },
}
