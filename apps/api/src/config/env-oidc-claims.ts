import type { RequiredClaim } from "./env-admin-types"

/**
 * Parses `ADMIN_OIDC_REQUIRED_CLAIMS`: comma-separated `name=value` pairs, every one of which the
 * verified id_token must satisfy. Names and values are trimmed; the value is everything after the
 * first `=`, so it may itself contain `=` but never a comma. Empty entries (a trailing comma) are
 * dropped, like `ADMIN_OIDC_ADMIN_EMAIL`'s, and exact duplicates collapse.
 *
 * A malformed entry is a boot error rather than a pair that silently never matches: `kind` (no
 * `=`), `=x` (no name) and `kind=` (no value) would otherwise read at sign-in as a broken IdP. A
 * value that names no pair at all (`","`) is refused for the same reason.
 */
export function parseRequiredClaims(
  spec: string,
): { readonly claims: readonly RequiredClaim[] } | { readonly error: string } {
  const claims: RequiredClaim[] = []
  for (const entry of spec.split(",")) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    const separator = trimmed.indexOf("=")
    const name = separator === -1 ? "" : trimmed.slice(0, separator).trim()
    const value = separator === -1 ? "" : trimmed.slice(separator + 1).trim()
    if (name.length === 0 || value.length === 0) {
      return { error: `entry "${trimmed}" is not a name=value pair` }
    }
    if (!claims.some((claim) => claim.name === name && claim.value === value)) {
      claims.push({ name, value })
    }
  }
  if (claims.length === 0) return { error: "must name at least one name=value pair" }
  return { claims }
}
