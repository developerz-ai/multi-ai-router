import { createHttpDriver } from "../driver"
import { messageRule } from "../failure/classify"
import type { ProviderDriver } from "../types"
import { OPENCODE_SESSION_HEADER, OPENCODE_USER_AGENT, opencodeRules } from "./opencode-failures"
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
 * A Go key the plan does not cover: Go Teams entitles workspace *members*, not service accounts, and
 * a team-owned key is refused on every model —
 * `403 "Go Teams covers workspace members, not service accounts. Use a personal API key to call Go
 * models."`, or `403 "This API key belongs to the team…"`.
 *
 * `credits-exhausted`, not `auth`: the key is valid, the plan simply does not pay for it, and no
 * clock or retry changes that — a human must issue a personal key or change the plan. Read as `auth`
 * it landed on `credential-rejected`, whose re-test is a half-open probe that spends a *client*
 * request: one seat failed a real request about every 4 h with a `502` while the rest of the pool
 * was cooling (prod 2026-11-09/10, sweep 101, 10.7). `exhausted` is re-tested only by the bounded
 * background re-check, never by routing a request to it (CLAUDE.md non-negotiable 7).
 *
 * Provenance: this router's production log, 2026-11-09..10 (accounts `e2d54875`, `0c688ac8`). Blast
 * radius: every Go `403` naming the team entitlement.
 */
const NOT_ENTITLED = /\bGo Teams covers workspace members\b|\bAPI key belongs to the team\b/i

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
    {
      dialect: "openai-chat",
      baseUrl: `${BASE_URL}/openai/v1`,
      sessionHeader: OPENCODE_SESSION_HEADER,
    },
    {
      dialect: "anthropic",
      baseUrl: `${BASE_URL}/anthropic`,
      anthropicAuth: "vendor-bearer",
      sessionHeader: OPENCODE_SESSION_HEADER,
      thinkingRequiredModels: THINKING_REQUIRED_MODELS,
    },
    {
      dialect: "openai-responses",
      baseUrl: `${BASE_URL}/openai/v1`,
      sessionHeader: OPENCODE_SESSION_HEADER,
    },
  ],
  rules: [
    messageRule("credits-exhausted", "opencode-go:plan-not-entitled", NOT_ENTITLED, {
      statuses: [403],
    }),
    ...opencodeRules("opencode-go"),
  ],
})

export const opencodeGoDriver: ProviderDriver = {
  ...driver,
  modelListing: opencodeModelListing,
  quotaRead: opencodeGoQuotaRead,
  buildHeaders: (account, credential) => {
    const headers = driver.buildHeaders(account, credential)
    headers.set("user-agent", OPENCODE_USER_AGENT)
    return headers
  },
}
