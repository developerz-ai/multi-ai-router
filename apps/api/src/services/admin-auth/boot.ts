/**
 * The boot-time rule for admin sign-in, as a pure function: **an OIDC relying
 * party or a local admin credential must exist**, and a local credential on a
 * publicly addressed router is refused unless the operator opted out of that
 * refusal by name.
 *
 * This check needs the database (the credential's existence *is* the row), so
 * it cannot live in `parseEnv` — `main.ts` runs it after migrations, before the
 * listener opens, and exits non-zero on a problem, exactly like a malformed
 * variable. The parse-time half (a partially configured OIDC block) stays in
 * `config/env.ts` and fails just as fast.
 *
 * The loopback rule is the threat model in one line: a password with no MFA in
 * front of it is a guessing surface, and the only honest default for one is
 * "this machine only". `ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC` exists because a LAN
 * install behind its own firewall is a real deployment shape — but the
 * operator says so by name, and the boot log warns about it every time.
 * Rationale: docs/idea/13-admin-oidc.md, issue #52.
 */

/** The doc every refusal message names, so the operator lands on the setup contract. */
export const ADMIN_AUTH_DOC = "docs/idea/13-admin-oidc.md"

export interface AdminAuthBootInput {
  /** `env.adminOidc !== null` — all four required OIDC variables parsed. */
  readonly oidcConfigured: boolean
  /** A hash row exists in `admin_credentials`. */
  readonly localCredentialConfigured: boolean
  /** `env.publicUrl` — the router's configured address, or null when unset. */
  readonly publicUrl: string | null
  /** `ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC`. */
  readonly allowPublicLocalLogin: boolean
}

/**
 * The refusal to print, or `null` when boot may proceed. The message is written
 * for the operator staring at a dead process: what is wrong, the three ways
 * forward, and the doc that owns the contract.
 */
export function adminAuthBootProblem(input: AdminAuthBootInput): string | null {
  if (!input.oidcConfigured && !input.localCredentialConfigured) {
    return (
      "Refusing to boot: no admin sign-in method is configured.\n" +
      `  Set the four ADMIN_OIDC_* variables (see ${ADMIN_AUTH_DOC}), or set a local\n` +
      "  admin password with `bin/admin set-password` and boot again."
    )
  }

  if (
    input.localCredentialConfigured &&
    !input.allowPublicLocalLogin &&
    input.publicUrl !== null &&
    !isLoopbackUrl(input.publicUrl)
  ) {
    return (
      "Refusing to boot: a local admin password is set, but PUBLIC_URL " +
      `(${input.publicUrl}) is not a loopback address — a password with no IdP in\n` +
      "  front of it is a credential-guessing surface on a publicly reachable router\n" +
      `  (see ${ADMIN_AUTH_DOC}).\n` +
      "  Remove the password (`bin/admin delete-password`), unset PUBLIC_URL, or — only\n" +
      "  if you accept that risk — set ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC=true and boot again."
    )
  }

  return null
}

/**
 * Whether a configured address names this machine and nothing else. Anything we
 * cannot positively read as loopback is treated as public — the refusal is the
 * safe direction to be wrong in, and the override exists for the false positive.
 */
export function isLoopbackUrl(raw: string): boolean {
  let hostname: string
  try {
    hostname = new URL(raw).hostname.toLowerCase()
  } catch {
    return false
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true
  // 127.0.0.0/8 is all loopback; the textual prefix check is the whole rule.
  if (hostname.startsWith("127.")) return true
  // URL parsing keeps IPv6 literal brackets on some engines and drops them on
  // others; accept both spellings of ::1 only.
  return hostname === "::1" || hostname === "[::1]"
}
