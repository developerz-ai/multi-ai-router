import { createHttpDriver } from "../driver"
import { codeRule } from "../failure/classify"
import { readFlatErrorFacts } from "../failure/error-body"
import { genericCreditsRule, throttleStatusRule } from "./compatible-rules"

/**
 * `cerebras` — Cerebras Inference's OpenAI-compatible surface. Own model ids (`llama-3.3-70b`,
 * `gpt-oss-120b`), so an Account here usually carries an alias map; the driver ships none.
 *
 * Two reasons this is more than a base URL:
 *
 *  - **Cerebras answers in the unwrapped envelope** — `{message, type, param, code}` at the top
 *    level, no `error` key — so the shared reader finds nothing and every failure would classify on
 *    its status alone. It shares that shape with Mistral, which is why the reader is shared too.
 *  - **A spent free-tier day is a `429`, not a billing state.** Cerebras meters tokens per minute,
 *    per hour and per day, and exceeding *any* of them is a rate limit that refills on a clock.
 *    Reading a spent daily allowance as `exhausted` would park an account for a human to fix
 *    something no human has to fix (CLAUDE.md non-negotiable 7).
 */

/**
 * Provenance: Cerebras' authentication and quickstart pages both address
 * `https://api.cerebras.ai/v1/chat/completions`, so `/v1` belongs to the base and the egress layer
 * appends the dialect's path below it. Blast radius: every `cerebras` request.
 */
const BASE_URL = "https://api.cerebras.ai/v1"

/**
 * Provenance: `wrong_api_key`, read at the top level of the body — the spelling Cerebras' own
 * `modelzoo` CLI checks for (`e.body["code"] == "wrong_api_key"`). Their published error page lists
 * statuses only, so `code` is the one field corroborated by their code rather than by prose; the
 * `type` beside it disagrees between captures and is deliberately not matched. Blast radius: a
 * rejected key relayed under any status but `401` would otherwise read as a client mistake.
 */
const AUTH_CODES = ["wrong_api_key"]

export const cerebrasDriver = createHttpDriver({
  id: "cerebras",
  surfaces: [{ dialect: "openai-chat", baseUrl: BASE_URL }],
  readFacts: readFlatErrorFacts,
  rules: [
    codeRule("auth", "cerebras:wrong_api_key", AUTH_CODES),
    // Cerebras' status table carries a `402` and says nothing else about it, so the status default
    // is the whole of the billing verdict; the shared wording is the backstop for a balance refused
    // under some other status. The throttle guard comes first because a spent daily token allowance
    // arrives as a `429` whose message names the allowance.
    throttleStatusRule,
    genericCreditsRule,
  ],
})
