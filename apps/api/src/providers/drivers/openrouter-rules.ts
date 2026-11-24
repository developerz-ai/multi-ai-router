import { z } from "zod"
import {
  accountScoped,
  type ClassificationRule,
  codeRule,
  keyCap,
  messageRule,
  modelScoped,
  onStatus,
  typeRule,
  withResetEstimate,
} from "../failure/classify"
import { readErrorFacts } from "../failure/error-body"
import { parseInstant } from "../rate-limit/duration"
import { parseRateLimitHeaders } from "../rate-limit/parse"
import type { RateLimitSignal, UpstreamErrorFacts, UpstreamResponse } from "../types"

/** What an OpenRouter refusal means. Sibling of `openrouter.ts`. */

/**
 * The fields OpenRouter tells a client to branch on: `error.metadata.limit_source` names which wall
 * refused, `reason` which case of it, `resets_at` the instant a budget window rolls over (`null` for
 * a lifetime one). Provenance: github.com/OpenRouterTeam/docs `api_reference/limits.mdx`, read
 * 2026-11-24 ("branch on `limit_source`, not on the hint text"). Blast radius: OpenRouter `402`s and
 * `403`s only; without the field every rule below reads the wording, as before.
 */
const Metadata = z.object({
  limit_source: z.string().nullish().catch(undefined),
  reason: z.string().nullish().catch(undefined),
  resets_at: z.string().nullish().catch(undefined),
})
const Body = z.object({ error: z.object({ metadata: Metadata }) })

const SPEND_STATUSES = [402, 403]
const KEY_SOURCE = "openrouter_key_limit"
const BALANCE_SOURCE = "openrouter_credits"
const IN_FLIGHT_SOURCE = "openrouter_in_flight_budget"
const BUDGET_SOURCES = ["openrouter_guardrail_budget", "openrouter_workspace_budget"]
/** `openrouter_credits` too, but about one request: its cost exceeds the whole in-flight budget. */
const OVERSIZED = "weight_exceeds_budget"

function metadataOf(body: unknown): z.infer<typeof Metadata> | undefined {
  let value = body
  if (typeof body === "string") {
    try {
      value = JSON.parse(body)
    } catch {
      return undefined
    }
  }
  return Body.safeParse(value).data?.error.metadata
}

/** OpenRouter states no `error.type`; the wall it names stands in its place for the rules. */
export function readOpenRouterFacts(body: unknown): UpstreamErrorFacts {
  const facts = readErrorFacts(body)
  const metadata = metadataOf(body)
  const wall = metadata?.reason === OVERSIZED ? OVERSIZED : metadata?.limit_source
  return wall === undefined || wall === null ? facts : { ...facts, type: wall }
}

/** A spent cap's own reset is in the body; the headers, if they ever state one, come first. */
export function parseOpenRouterRateLimit(response: UpstreamResponse): RateLimitSignal | null {
  const fromHeaders = parseRateLimitHeaders(response)
  if (!SPEND_STATUSES.includes(response.status)) return fromHeaders
  if (fromHeaders?.resetsAt !== undefined || fromHeaders?.retryAfterSeconds !== undefined)
    return fromHeaders
  const metadata = metadataOf(response.body)
  const source = metadata?.limit_source ?? ""
  if (source !== KEY_SOURCE && !BUDGET_SOURCES.includes(source)) return fromHeaders
  const resetsAt = parseInstant(metadata?.resets_at ?? "")
  if (resetsAt === null) return fromHeaders
  return {
    limited: true,
    resetsAt,
    resetSource: "provider-reported",
    windows: fromHeaders?.windows ?? [],
  }
}

/**
 * Provenance: OpenRouter answers a spent balance with `402` and a message naming credits, and
 * echoes the numeric HTTP status back in `error.code` rather than a string identifier. Blast
 * radius: the wording rule is what catches a `402` proxied through as a `403`; it never reads a
 * `400`/`404`, where OpenRouter echoes the requested model id (sweep 101, 04.1).
 */
const INSUFFICIENT_CREDITS = /insufficient credits|requires more credits|add more using/i

/**
 * A per-key spend cap the operator set on the OpenRouter key, announced as
 * `403 "Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/…"`.
 *
 * Provenance: this router's production log, 2026-10-04 21:54Z — read as `http-status:403` → `auth`,
 * so a healthy key sat in "credential rejected" on the auth re-test cadence. It is not a credential
 * fault: the key is valid and its *spend* is capped. A `total` cap (or one naming no window) lifts
 * only when a human raises it, so it is `credits-exhausted` (402, never retried on a timer). A key
 * whose cap resets `daily` / `weekly` / `monthly` (OpenRouter's `limit_reset`, at 00:00 UTC) reopens
 * on a clock, so it is `rate-limited` with an estimated re-test — the reset instant is not in the
 * body, and the window wording is inferred from the `(total limit)` form, not yet observed.
 *
 * Blast radius: every OpenRouter 403 naming a key limit. Window first, so a resetting cap is never
 * parked as permanent.
 */
const KEY_LIMIT_WINDOW = /key limit exceeded\s*\((?:daily|weekly|monthly) limit\)/i
const KEY_LIMIT = /key limit exceeded/i

/**
 * The other announcement of the same resetting cap: a `402` for a request whose reserved `max_tokens`
 * the cap's remainder cannot cover — `This request requires more credits, or fewer max_tokens. You
 * requested up to N tokens, but can only afford M. To increase, … create a key with a higher total
 * limit` — so a cap at 99.9% refuses before it reads as spent. Provenance: community.n8n.io/t/267444
 * quotes the `total` form (2026-02); the windowed forms are by analogy with {@link KEY_LIMIT_WINDOW},
 * not captured. Prod 2026-11-23 22:30Z (#441): a daily cap refused, the account parked `exhausted`,
 * and clients were told to top up for three hours past the 00:00Z reset. Blast radius: an OpenRouter
 * `402`/`403` naming a windowed key limit cools instead of parking; a `total` one stays a human's.
 *
 * `adjust the key's monthly limit` is the same cap refusing the prompt itself (`402 "Prompt tokens
 * limit exceeded: 13485 > 561. To increase, visit …/keys/… and adjust the key's monthly limit"`,
 * github.com/aiur-team/aiur/issues/8035, read 2026-11-24).
 */
const HIGHER_WINDOW_LIMIT =
  /(?:key with a higher|adjust the key['’]s) (?:daily|weekly|monthly) limit/i

/**
 * Re-test cadence for a resetting key cap: the earliest a daily window can reopen is hours away,
 * and one probe an hour is all a still-capped key costs. Provenance: chosen 2026-10-04. Blast
 * radius: how soon a key whose daily cap reset is found serving again.
 */
const KEY_LIMIT_RETEST_SECONDS = 60 * 60

/**
 * The refusal itself, for a namespaced id it does not carry — or no longer carries: a delisted model
 * answers `404 "<id> is no longer available on OpenRouter"` (prod 2026-11-09..10, `inception/mercury-2`,
 * 40 client-visible `404`s in 37.5 h; sweep 101, 10.16). About the name, so the next account gets its
 * turn and this one is not struck. Provenance: the two log lines. Blast radius: without it the chain
 * stops at this account.
 */
const MODEL_REFUSED = /is not a valid model id|is no longer available/i

/**
 * No endpoint carries the id at all: `404 "No endpoints found for <id>."`. About the name, as above.
 * Provenance: github.com/Aider-AI/aider/issues/2444. Blast radius: the model is held off this
 * account for `MODEL_REFUSAL_TTL_SECONDS`, so the pattern takes the bare form only.
 */
const NO_ENDPOINTS = /^no endpoints found for [^\s:]+(?::[^\s:]+)?\.?$/i

/**
 * No endpoint is left once the filters on **this account's** request apply — the `provider`
 * preferences the account or the client states, the account's data policy, a tool or an image the
 * endpoints left do not take. Provenance: prod
 * 2026-11-24 04:06Z, `404 "No endpoints found for the request with quantization: fp8,bf16…"`, caused
 * by the account's own preferences and relayed to the client; `that support tool use` is
 * github.com/anomalyco/opencode/issues/1002 and `matching your data policy` help.janitorai.com's
 * OpenRouter guide, both read 2026-11-23. Not a verdict on the name: a hold would keep the model from
 * a plain request it does serve. Not one on the vendor either: an OpenRouter sibling with no such
 * filter serves it. Blast radius: each OpenRouter account in the chain is asked once.
 */
const REQUEST_FILTERED =
  /^no endpoints found (?:for the request with|that support|matching your data policy)/i

/**
 * A `429` OpenRouter relays from the provider serving one model — `{"error":{"message":"Provider
 * returned error","code":429,"metadata":{"raw":"<model> is temporarily rate-limited upstream…",
 * "provider_name":…}}}` — is that model's endpoint throttling, not this key. Provenance:
 * openrouter.ai/docs/api-reference/errors (`metadata.provider_name` names the provider that raised
 * it), and this router's production log, 2026-11-14: one `google/gemma-4-31b-it:free` 429 cooled the
 * whole `openrouter-dz-coding-30d` account and its next, paid, model was refused. Blast radius: an
 * OpenRouter 429 with that wording holds only the model it was for.
 */
const UPSTREAM_THROTTLE = /provider returned error|rate-limited upstream/i

/**
 * The wording of a spend refusal that names the prepaid **balance**: `… can only afford N. To
 * increase, visit https://openrouter.ai/settings/credits and …`, `Insufficient credits. Add more
 * using …`. Provenance: `fixtures.ts` (the live body) and github.com/continuedev/continue/issues/10298,
 * read 2026-11-24. Blast radius: such a refusal never borrows a key cap's reset.
 */
const NAMES_BALANCE = /settings\/credits|insufficient credits|add more (?:using|credits)/i

/** One of `rules`, with a stated reset: a clock, whatever the sentence beside it says. */
function whenReset(rule: ClassificationRule): ClassificationRule {
  return {
    ...rule,
    when: (facts, status, stated) => stated.reset && rule.when(facts, status, stated),
  }
}

/** A credits refusal that does not name the balance, so the key's own cap may be what it is. */
function unlessBalance(rule: ClassificationRule): ClassificationRule {
  return keyCap({
    ...rule,
    when: (facts, status, stated) =>
      facts.type !== BALANCE_SOURCE &&
      !NAMES_BALANCE.test(facts.message ?? "") &&
      rule.when(facts, status, stated),
  })
}

const INSUFFICIENT = messageRule(
  "credits-exhausted",
  "openrouter:insufficient-credits",
  INSUFFICIENT_CREDITS,
  { statuses: SPEND_STATUSES },
)
const CODE_402 = codeRule("credits-exhausted", "openrouter:code-402", ["402"])

/** The walls OpenRouter names itself, ahead of every reading of its wording. */
const STATED_RULES: readonly ClassificationRule[] = [
  typeRule("rate-limited", "openrouter:in-flight-budget", [IN_FLIGHT_SOURCE]),
  accountScoped(typeRule("invalid-request", "openrouter:request-over-budget", [OVERSIZED])),
  whenReset(typeRule("rate-limited", "openrouter:key-limit-window", [KEY_SOURCE])),
  whenReset(typeRule("rate-limited", "openrouter:budget-window", BUDGET_SOURCES)),
  typeRule("credits-exhausted", "openrouter:budget-spent", BUDGET_SOURCES),
].map((rule) => onStatus(SPEND_STATUSES, rule))

export const OPENROUTER_RULES: readonly ClassificationRule[] = [
  ...STATED_RULES,
  modelScoped(
    messageRule("rate-limited", "openrouter:upstream-throttle", UPSTREAM_THROTTLE, {
      statuses: [429],
    }),
  ),
  keyCap(
    withResetEstimate(
      messageRule("rate-limited", "openrouter:key-limit-window", KEY_LIMIT_WINDOW, {
        statuses: [403],
      }),
      KEY_LIMIT_RETEST_SECONDS,
    ),
  ),
  keyCap(
    withResetEstimate(
      messageRule("rate-limited", "openrouter:key-limit-window", HIGHER_WINDOW_LIMIT, {
        statuses: SPEND_STATUSES,
      }),
      KEY_LIMIT_RETEST_SECONDS,
    ),
  ),
  keyCap(messageRule("credits-exhausted", "openrouter:key-limit", KEY_LIMIT, { statuses: [403] })),
  keyCap(
    onStatus(SPEND_STATUSES, typeRule("credits-exhausted", "openrouter:key-limit", [KEY_SOURCE])),
  ),
  messageRule(
    "invalid-request",
    "openrouter:moderation",
    /moderation|flagged[^.]{0,80}content|content[^.]{0,80}flagged/i,
    { statuses: [403] },
  ),
  messageRule("model-unsupported", "openrouter:model-unsupported", MODEL_REFUSED, {
    statuses: [400, 404],
  }),
  messageRule("model-unsupported", "openrouter:no-endpoints", NO_ENDPOINTS, { statuses: [404] }),
  accountScoped(
    messageRule("invalid-request", "openrouter:request-filtered", REQUEST_FILTERED, {
      statuses: [404],
    }),
  ),
  unlessBalance(INSUFFICIENT),
  INSUFFICIENT,
  unlessBalance(CODE_402),
  CODE_402,
  codeRule("rate-limited", "openrouter:code-429", ["429"]),
  codeRule("auth", "openrouter:code-401", ["401"]),
]
