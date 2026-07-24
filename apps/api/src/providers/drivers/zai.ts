import { createHttpDriver } from "../driver"
import { codeRule, messageRule } from "../failure/classify"

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

const INSUFFICIENT_BALANCE = /insufficient balance|balance is insufficient|account balance/i

export const zaiDriver = createHttpDriver({
  id: "zai",
  surfaces: [
    // Verified: the operator drives this endpoint with Claude Code's `ANTHROPIC_AUTH_TOKEN`,
    // i.e. `Authorization: Bearer`. Blast radius of `x-api-key` here: an unexpected header a
    // vendor may reject or log.
    { dialect: "anthropic", baseUrl: ANTHROPIC_BASE_URL, anthropicAuth: "vendor-bearer" },
    { dialect: "openai-chat", baseUrl: OPENAI_BASE_URL },
  ],
  rules: [
    codeRule("credits-exhausted", "zai:balance-code", BALANCE_CODES),
    messageRule("credits-exhausted", "zai:insufficient-balance", INSUFFICIENT_BALANCE),
    codeRule("rate-limited", "zai:throttle-code", THROTTLE_CODES),
    codeRule("auth", "zai:auth-code", AUTH_CODES),
  ],
})
