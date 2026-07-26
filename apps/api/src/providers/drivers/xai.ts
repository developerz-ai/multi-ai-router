import { createHttpDriver } from "../driver"
import { genericCreditsRule, throttleStatusRule } from "./compatible-rules"

/**
 * `xai` — Grok over xAI's OpenAI-compatible surface. Own model ids (`grok-4`, `grok-4-fast`), so an
 * Account here usually carries an alias map; the driver ships none.
 *
 * Two things shape this file, and both are absences rather than quirks:
 *
 *  - **xAI answers in two error shapes.** Chat completions use OpenAI's nested
 *    `{error:{message,type,code}}`; the Responses surface uses a flat `{code, error}` whose `code`
 *    is an English sentence ("Client specified an invalid argument"), not a machine token. The
 *    shared reader already covers both — the flat form's `error` string becomes the message — and
 *    nothing here keys on `code`, because a sentence is not an enum.
 *  - **xAI documents no status for a depleted balance.** Its billing page states only that requests
 *    "will be automatically rejected once your prepaid credits are depleted", and its error list
 *    stops at 429 without naming a 402. The one 403 it does document is a permissions refusal, and
 *    the 403 that names credits belongs to the consumer SuperGrok surface, not to an API key. So
 *    this driver encodes no xAI-specific credit rule: a guess here parks a healthy account at a
 *    status no clock undoes.
 */

/**
 * Provenance: xAI's API reference — the base a stock OpenAI client is pointed at. Regional hosts
 * (`https://eu-west-1.api.x.ai/v1`) are an Account base-URL override, not a second constant here.
 * Blast radius: every `xai` request.
 */
const BASE_URL = "https://api.x.ai/v1"

export const xaiDriver = createHttpDriver({
  id: "xai",
  surfaces: [{ dialect: "openai-chat", baseUrl: BASE_URL }],
  // The shared pair, and deliberately nothing of xAI's own. The signal the second one records
  // (`compatible:out-of-credits-wording`) says out loud that the verdict came from phrasing rather
  // than from a vocabulary xAI publishes — which is exactly what an operator needs to know here.
  rules: [throttleStatusRule, genericCreditsRule],
})
