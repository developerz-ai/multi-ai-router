import { createHttpDriver } from "../driver"
import { genericCreditsRule } from "./compatible-rules"

/**
 * `anthropic-compatible` — the escape hatch for any Anthropic-shaped endpoint. Operator-supplied
 * base URL, and the verified Anthropic header rules apply unchanged: an API key on `x-api-key`
 * plus `anthropic-version`, an OAuth token on `Authorization: Bearer` plus the beta header.
 *
 * It keeps Anthropic's own rules rather than the compatible vendors' Bearer form: the endpoint
 * behind it is unknown, and the common case is an Account pointed at Anthropic through a proxy.
 * A vendor that wants the Bearer form has a named driver, or earns one.
 */
export const anthropicCompatibleDriver = createHttpDriver({
  id: "anthropic-compatible",
  surfaces: [{ dialect: "anthropic", baseUrl: null }],
  rules: [genericCreditsRule],
})
