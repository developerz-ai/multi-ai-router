import { z } from "zod"
import { createHttpDriver } from "../driver"
import type { ClassificationRule } from "../failure/classify"
import { readErrorFacts } from "../failure/error-body"
import type { ProviderDriver, UpstreamErrorFacts } from "../types"
import { genericCreditsRule, throttleStatusRule } from "./compatible-rules"

/**
 * `nvidia` — NVIDIA's hosted NIM endpoints (build.nvidia.com), an OpenAI-compatible surface over
 * open-weight models with a free developer allowance. Ids are namespaced (`z-ai/glm-5.3-flash`) and
 * often equal to OpenRouter's without its `:free` suffix, so an alias map is usually wanted.
 */

/**
 * Provenance: docs.api.nvidia.com, and `GET /models` answering live, 2026-11-23. Blast radius: every
 * `nvidia` request.
 */
const BASE_URL = "https://integrate.api.nvidia.com/v1"

/**
 * Every hosted id is `vendor/model` with no variant suffix, so a bare name or a `:free` one is never
 * NVIDIA's. Provenance: `GET /models`, read 2026-11-23. Blast radius: what an Account with no
 * declared models is a candidate for; an alias or `supportedModels` still admits anything.
 */
const MODEL_ID = /^[^/\s:]+\/[^/\s:]+$/

/**
 * A `404` or `410` on the one path this driver calls is about the model: an id it does not host
 * answers a bare `404 page not found` (live, 2026-11-23), one the key may not run answers `404
 * "Function … Not found for account"`, and a retired one `410`. The next account gets its turn.
 * Blast radius: without it a name this key cannot serve ends the chain as the client's mistake.
 */
const MODEL_REFUSED_STATUSES = [404, 410]

const modelRefusedRule: ClassificationRule = {
  kind: "model-unsupported",
  signal: "nvidia:model-refused",
  when: (_facts, status) => MODEL_REFUSED_STATUSES.includes(status),
}

/**
 * The allowance "varies by model" (build.nvidia.com, "up to 40 rpm", read 2026-11-23), so a `429`
 * holds the model it was for and the key's other models keep serving. If a limit turns out to be the
 * key's, the cost is one refusal per model before each is held.
 */
const PER_MODEL_LIMITS = /./

/** RFC 7807 problem details (`{"status":403,"title":"Forbidden","detail":"Authorization failed"}`). */
const Problem = z.object({ detail: z.string(), title: z.string().nullish().catch(undefined) })

function readNvidiaFacts(body: unknown): UpstreamErrorFacts {
  const problem = Problem.safeParse(body)
  if (!problem.success) return readErrorFacts(body)
  return {
    message: problem.data.detail,
    ...(problem.data.title ? { type: problem.data.title } : {}),
  }
}

const driver = createHttpDriver({
  id: "nvidia",
  surfaces: [{ dialect: "openai-chat", baseUrl: BASE_URL }],
  readFacts: readNvidiaFacts,
  modelScopedRateLimits: PER_MODEL_LIMITS,
  rules: [modelRefusedRule, throttleStatusRule, genericCreditsRule],
})

export const nvidiaDriver: ProviderDriver = {
  ...driver,
  modelFamily: { patterns: [MODEL_ID] },
  freeTier: {
    access: "free-key",
    url: "https://build.nvidia.com/settings/api-keys",
    note: "Free developer key: up to 40 requests a minute and 10,000 a day, varying by model. Rate limits: https://build.nvidia.com/api/runtime/content/copy.yaml (separate from the key page at https://build.nvidia.com/settings/api-keys). Terms: prototyping and development, not serving end users.",
    verifiedAt: "2026-11-23",
  },
}
