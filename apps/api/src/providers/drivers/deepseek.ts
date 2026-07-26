import { createHttpDriver } from "../driver"
import { messageRule } from "../failure/classify"

/**
 * `deepseek` — DeepSeek's OpenAI-compatible surface. Own model ids (`deepseek-chat`,
 * `deepseek-reasoner`), so an Account here usually carries an alias map; the driver ships none.
 *
 * Unusually for this directory, nearly every DeepSeek failure classifies correctly on its HTTP
 * status alone: the vendor publishes a status table and honors it, including the one case most
 * providers get wrong — **a spent balance is a real `402`**, not Anthropic's `400` or OpenAI's `429`.
 *
 * What this file is careful *not* to do is read DeepSeek's `error.type` or `error.code`. Its bodies
 * are OpenAI-shaped, but the two fields are inverted and inconsistent: a `402` carries
 * `type: "unknown_error"` beside `code: "invalid_request_error"`, and a `401` carries
 * `type: "authentication_error"` beside the same `code`. A rule keyed on either would read a dead
 * balance as a malformed request.
 */

/**
 * Provenance: DeepSeek's quick start — the OpenAI-format base is the bare host, with
 * `https://api.deepseek.com/v1` accepted as an alias whose `v1` names no model version. The bare
 * form is pinned because it is the one the vendor documents; either resolves the same paths, since
 * the egress layer appends `/chat/completions` and `/models` below whatever the base carries. Blast
 * radius: every `deepseek` request.
 */
const BASE_URL = "https://api.deepseek.com"

/**
 * Provenance: DeepSeek's error-code table — `402 Insufficient Balance`, "You have run out of
 * balance", cleared only by topping up. The wire body repeats the phrase verbatim in
 * `error.message`. Blast radius: the status alone already lands on `credits-exhausted`, so this rule
 * is for the relayed case — a gateway that forwards the body under a status of its own — and for
 * recording a signal an operator can read back instead of a bare `http-status:402`.
 */
const INSUFFICIENT_BALANCE = /insufficient balance/i

export const deepSeekDriver = createHttpDriver({
  id: "deepseek",
  surfaces: [{ dialect: "openai-chat", baseUrl: BASE_URL }],
  rules: [messageRule("credits-exhausted", "deepseek:insufficient-balance", INSUFFICIENT_BALANCE)],
})
