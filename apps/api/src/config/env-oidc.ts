import type { z } from "zod"
import type { AdminOidcConfig, RequiredClaim } from "./env-admin-types"
import { parseRequiredClaims } from "./env-oidc-claims"
import type { ParsedEnv } from "./env-schema"

const DOC = "see docs/idea/13-admin-oidc.md"

export function readAdminOidcEnv(
  raw: ParsedEnv,
  ctx: z.RefinementCtx,
): AdminOidcConfig | null | undefined {
  // OIDC is all-or-nothing at parse time. Every variable below absent means "local login only",
  // which is legal — whether *some* sign-in method exists is decided after migrations, because the
  // local credential's existence is a row in the database (`services/admin-auth/boot.ts`). Any of
  // them set makes it a block, and a block needs the issuer, the client id, the redirect URI and at
  // least one principal gate: an email allowlist, required claims, or both. A partial block is
  // neither and fails here, naming every missing field and pointing at the doc.
  const isSet = (value: string | undefined): value is string =>
    typeof value === "string" && value.length > 0
  const requiredOidc = [
    "ADMIN_OIDC_ISSUER_URL",
    "ADMIN_OIDC_CLIENT_ID",
    "ADMIN_OIDC_REDIRECT_URI",
  ] as const
  const emailSpec = raw.ADMIN_OIDC_ADMIN_EMAIL
  const claimsSpec = raw.ADMIN_OIDC_REQUIRED_CLAIMS
  const missingOidc = requiredOidc.filter((env) => !isSet(raw[env]))
  const gateSet = isSet(emailSpec) || isSet(claimsSpec)
  if (missingOidc.length === requiredOidc.length && !gateSet) return null

  let valid = true
  const refuse = (env: string, message: string): void => {
    ctx.addIssue({ code: "custom", path: [env], message: `${message} — ${DOC}` })
    valid = false
  }
  for (const env of missingOidc) refuse(env, "is required once any ADMIN_OIDC_* variable is set")
  if (!gateSet) {
    // Both named, on both paths: either one is the fix, and an operator grepping for one finds it.
    for (const env of ["ADMIN_OIDC_ADMIN_EMAIL", "ADMIN_OIDC_REQUIRED_CLAIMS"]) {
      refuse(
        env,
        "ADMIN_OIDC_ADMIN_EMAIL or ADMIN_OIDC_REQUIRED_CLAIMS (or both) is required once any ADMIN_OIDC_* variable is set",
      )
    }
  }

  // Comma-separated, so one operator per entry. Lowercased here rather than at the comparison so
  // the flow compares two already-normalized values, and deduplicated so a repeated entry cannot
  // make the allowlist look longer than the number of humans it admits. A value that parses to
  // *zero* emails (`","`, `" "`) is an operator mistake that would otherwise configure OIDC with
  // an allowlist nobody can satisfy — every login would fail the principal check, which reads as a
  // broken IdP rather than a typo here. Unset is different: it means "no email gate", and is only
  // legal because required claims then gate instead (checked above).
  let adminEmails: readonly string[] | null = null
  if (isSet(emailSpec)) {
    adminEmails = [
      ...new Set(
        emailSpec
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0),
      ),
    ]
    if (adminEmails.length === 0) refuse("ADMIN_OIDC_ADMIN_EMAIL", "must name at least one email")
  }

  let requiredClaims: readonly RequiredClaim[] = []
  if (isSet(claimsSpec)) {
    const parsed = parseRequiredClaims(claimsSpec)
    if ("error" in parsed) refuse("ADMIN_OIDC_REQUIRED_CLAIMS", parsed.error)
    else requiredClaims = parsed.claims
  }

  if (!valid) return undefined
  return {
    issuerUrl: raw.ADMIN_OIDC_ISSUER_URL as string,
    clientId: raw.ADMIN_OIDC_CLIENT_ID as string,
    clientSecret: raw.ADMIN_OIDC_CLIENT_SECRET ?? null,
    redirectUri: raw.ADMIN_OIDC_REDIRECT_URI as string,
    adminEmails,
    requiredClaims,
    adminSubject: raw.ADMIN_OIDC_ADMIN_SUBJECT ?? null,
    scopes: (raw.ADMIN_OIDC_SCOPES ?? "openid profile email").split(/\s+/u).filter(Boolean),
    clockSkewSeconds: raw.ADMIN_OIDC_CLOCK_SKEW_SECONDS ?? 60,
    requestTimeoutMs: raw.ADMIN_OIDC_REQUEST_TIMEOUT_MS ?? 10_000,
  }
}
