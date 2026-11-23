import { z } from "zod"
import { createHttpDriver } from "../driver"
import {
  codeRule,
  messageRule,
  modelScoped,
  typeRule,
  withResetEstimate,
} from "../failure/classify"
import { readErrorFacts } from "../failure/error-body"
import type { ListedModel, ProviderModelListing } from "../model-listing"
import type { ProviderDriver, UpstreamErrorFacts } from "../types"
import { genericCreditsRule } from "./compatible-rules"

/**
 * `kilo` — the Kilo gateway, whose free models answer **with no credential at all**. Its free ids are
 * OpenRouter's own (`nvidia/nemotron-3.5-super-vl:free`), so a keyless Kilo Account beside an
 * `openrouter` one in a pool is a second source for the same name with no alias map.
 *
 * `authKind: "none"`: a credential is optional, exactly as for `ollama` — but the endpoint is pinned
 * and public. A signed-in key is sent as `Authorization: Bearer` and is counted per account rather
 * than per address.
 */

/**
 * Provenance: kilo.ai/docs/gateway and a live keyless tool call, 2026-11-23. Blast radius: every
 * `kilo` request.
 */
const BASE_URL = "https://api.kilo.ai/api/gateway"

/**
 * The names an Account with no declared models serves: free variants and the two free auto routers.
 * Every other id is metered and answers `401 PAID_MODEL_AUTH_REQUIRED` without a funded key, so an
 * undeclared Account must not be a candidate for it. Discover (`supportedModels`) adds the free ids
 * that carry no suffix (`stealth/…`), and an operator who funded a key lists paid ones the same way.
 * Provenance: `GET /models`, read 2026-11-23. Blast radius: which names reach a fresh Account.
 */
const FREE_MODEL_IDS = [
  /^[^/\s]+\/[^/\s]+:free$/,
  /^[^/\s]+\/[^/\s:]+-free$/,
  /^(?:kilo-auto|openrouter)\/free$/,
] as const

/**
 * A paid id, or one it does not carry, asked without a funded key: `401 {"error":{"code":
 * "PAID_MODEL_AUTH_REQUIRED"}}`, the same answer for both. Provenance: live, 2026-11-23. About the
 * name, never the Account — read as `auth` it would park a keyless Account nobody can re-authorize.
 */
const PAID_MODEL = ["PAID_MODEL_AUTH_REQUIRED"]

/**
 * `error_type` values, beside `error` rather than inside it. Provenance: Kilo-Org/cloud
 * `packages/web-shared/src/lib/proxy-error-types.ts` and `ai-gateway/llm-proxy-helpers.ts`, read
 * 2026-11-23: each is a `404` (or, for the free auto router with nothing left, a `503`) about the
 * requested name. Blast radius: without it a retired id stops the chain as the client's mistake.
 */
const MODEL_REFUSED = [
  "model_not_found",
  "unavailable_model",
  "model_not_allowed",
  "no_free_models_available",
]

/** The upstream serving one model is throttled; OpenRouter's wording, relayed (live, 2026-11-23). */
const UPSTREAM_THROTTLE = /provider returned error|rate-limited upstream/i

/**
 * The allowance itself: `429 "Rate limit exceeded for free models. Please try again later."`, 200
 * requests an hour per egress address, shared by every free model and stating no reset. Provenance:
 * kilo.ai/docs/gateway/usage-and-billing, read 2026-11-23. Account-wide, so it must not be read as
 * one model's throttle: that walks every model into the same wall, one refusal each.
 */
const FREE_ALLOWANCE = /rate limit exceeded for free models/i

/**
 * Re-test cadence for that allowance. The window is an hour and slides, so some of it has usually
 * reopened within minutes. Chosen 2026-11-23, not published. Blast radius: how long a spent address
 * is passed over, and how many refusals it costs to find out.
 */
const FREE_ALLOWANCE_RETEST_SECONDS = 5 * 60

const ErrorType = z.object({ error_type: z.string() })

/** The shared envelope, with Kilo's sibling `error_type` standing in where `error` carries no type. */
function readKiloFacts(body: unknown): UpstreamErrorFacts {
  const facts = readErrorFacts(body)
  const parsed = ErrorType.safeParse(typeof body === "string" ? parseJson(body) : body)
  return parsed.success && facts.type === undefined
    ? { ...facts, type: parsed.data.error_type }
    : facts
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const size = z
  .unknown()
  .transform((value) =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null,
  )

const Listing = z.object({
  data: z.array(
    z.looseObject({
      id: z.string().trim().min(1),
      isFree: z.boolean().optional().catch(undefined),
      context_length: size.optional(),
      architecture: z
        .looseObject({ output_modalities: z.array(z.string()).optional() })
        .optional()
        .catch(undefined),
      top_provider: z
        .looseObject({ context_length: size.optional(), max_completion_tokens: size.optional() })
        .nullish()
        .catch(undefined),
    }),
  ),
})

/**
 * Free text models only. The listing is an aggregator's whole catalog (~500 ids) and everything in
 * it but these needs a funded key; advertising the rest would offer clients names that answer `401`.
 * Provenance: `isFree` on `GET /models`, read 2026-11-23.
 */
export const kiloModelListing: ProviderModelListing = {
  query: () => ({}),
  read: (body): readonly ListedModel[] | null => {
    const parsed = Listing.safeParse(body)
    if (!parsed.success) return null
    return parsed.data.data
      .filter((model) => model.isFree === true)
      .filter((model) => {
        const output = model.architecture?.output_modalities
        return output === undefined || (output.length === 1 && output[0] === "text")
      })
      .map((model) => ({
        id: model.id,
        contextTokens: model.top_provider?.context_length ?? model.context_length ?? null,
        maxOutputTokens: model.top_provider?.max_completion_tokens ?? null,
      }))
  },
}

const driver = createHttpDriver({
  id: "kilo",
  authKind: "none",
  surfaces: [{ dialect: "openai-chat", baseUrl: BASE_URL }],
  readFacts: readKiloFacts,
  rules: [
    codeRule("model-unsupported", "kilo:paid-model", PAID_MODEL),
    typeRule("model-unsupported", "kilo:model-refused", MODEL_REFUSED),
    withResetEstimate(
      messageRule("rate-limited", "kilo:free-allowance", FREE_ALLOWANCE, { statuses: [429] }),
      FREE_ALLOWANCE_RETEST_SECONDS,
    ),
    modelScoped(
      messageRule("rate-limited", "kilo:upstream-throttle", UPSTREAM_THROTTLE, {
        statuses: [429],
      }),
    ),
    genericCreditsRule,
  ],
})

export const kiloDriver: ProviderDriver = {
  ...driver,
  modelFamily: { patterns: FREE_MODEL_IDS },
  modelListing: kiloModelListing,
  freeTier: {
    access: "keyless",
    url: "https://kilo.ai/docs/gateway/usage-and-billing",
    note: "No key needed for free models: 200 requests an hour per address. Free ids rotate, and prompts may be logged or used for training by the host.",
    verifiedAt: "2026-11-23",
  },
}
