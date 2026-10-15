import type { RequiredClaim } from "../../../config/env-admin-types"

/**
 * The first `ADMIN_OIDC_REQUIRED_CLAIMS` pair the verified id_token fails, as an operator-facing
 * reason, or `null` when every pair matches. Pure, so the whole rule is unit-testable.
 *
 * A claim matches when it is a string equal to the value, or an array with an element equal to
 * it — exact and case-sensitive; an IdP that changes a value's case has changed who it admits. A
 * missing claim, or one of any other shape (number, boolean, object, null), fails closed: the
 * router never guesses a coercion. The reason names the claim and the configured value, which the
 * operator wrote, and never the token's own value — the same discipline as the email check, which
 * names only the address the IdP asserted.
 */
export function unmetRequiredClaim(
  claims: Readonly<Record<string, unknown>>,
  required: readonly RequiredClaim[],
): string | null {
  for (const { name, value } of required) {
    const actual = Object.hasOwn(claims, name) ? claims[name] : undefined
    if (actual === undefined) {
      return `id_token has no "${name}" claim (ADMIN_OIDC_REQUIRED_CLAIMS requires ${name}=${value})`
    }
    if (typeof actual === "string") {
      if (actual === value) continue
    } else if (Array.isArray(actual)) {
      if (actual.some((element) => element === value)) continue
    } else {
      return `id_token claim "${name}" is neither a string nor an array (ADMIN_OIDC_REQUIRED_CLAIMS requires ${name}=${value})`
    }
    return `id_token claim "${name}" does not match ADMIN_OIDC_REQUIRED_CLAIMS ${name}=${value}`
  }
  return null
}
