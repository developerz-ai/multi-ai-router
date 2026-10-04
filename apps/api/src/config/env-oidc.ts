import type { z } from "zod"
import type { AdminOidcConfig } from "./env-admin-types"
import type { ParsedEnv } from "./env-schema"

export function readAdminOidcEnv(
  raw: ParsedEnv,
  ctx: z.RefinementCtx,
): AdminOidcConfig | null | undefined {
  // OIDC is all-or-nothing at parse time. All four absent means "local login
  // only", which is legal — whether *some* sign-in method exists is decided
  // after migrations, because the local credential's existence is a row in the
  // database (`services/admin-auth/boot.ts`). A partial block is neither and
  // fails here, naming every missing field and pointing at the doc.
  const requiredOidc: ReadonlyArray<{ key: keyof typeof raw; env: string }> = [
    { key: "ADMIN_OIDC_ISSUER_URL", env: "ADMIN_OIDC_ISSUER_URL" },
    { key: "ADMIN_OIDC_CLIENT_ID", env: "ADMIN_OIDC_CLIENT_ID" },
    { key: "ADMIN_OIDC_REDIRECT_URI", env: "ADMIN_OIDC_REDIRECT_URI" },
    { key: "ADMIN_OIDC_ADMIN_EMAIL", env: "ADMIN_OIDC_ADMIN_EMAIL" },
  ]
  const missingOidc: string[] = []
  for (const { key, env } of requiredOidc) {
    const value = raw[key]
    if (typeof value !== "string" || value.length === 0) missingOidc.push(env)
  }
  const oidcConfigured = missingOidc.length === 0
  if (!oidcConfigured && missingOidc.length < requiredOidc.length) {
    for (const env of missingOidc) {
      ctx.addIssue({
        code: "custom",
        path: [env],
        message: `is required once any ADMIN_OIDC_* variable is set — see docs/idea/13-admin-oidc.md`,
      })
    }
    return undefined
  }

  // Comma-separated, so one operator per entry. Lowercased here rather than at the comparison so
  // the flow compares two already-normalized values, and deduplicated so a repeated entry cannot
  // make the allowlist look longer than the number of humans it admits. A value that parses to
  // *zero* emails (`","`, `" "`) is an operator mistake that would otherwise configure OIDC with
  // an allowlist nobody can satisfy — every login would fail the principal check, which reads as a
  // broken IdP rather than a typo here.
  const adminEmails = oidcConfigured
    ? [
        ...new Set(
          (raw.ADMIN_OIDC_ADMIN_EMAIL as string)
            .split(",")
            .map((entry) => entry.trim().toLowerCase())
            .filter((entry) => entry.length > 0),
        ),
      ]
    : []
  if (oidcConfigured && adminEmails.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["ADMIN_OIDC_ADMIN_EMAIL"],
      message: `must name at least one email — see docs/idea/13-admin-oidc.md`,
    })
    return undefined
  }

  return oidcConfigured
    ? {
        issuerUrl: raw.ADMIN_OIDC_ISSUER_URL as string,
        clientId: raw.ADMIN_OIDC_CLIENT_ID as string,
        clientSecret: raw.ADMIN_OIDC_CLIENT_SECRET ?? null,
        redirectUri: raw.ADMIN_OIDC_REDIRECT_URI as string,
        adminEmails,
        adminSubject: raw.ADMIN_OIDC_ADMIN_SUBJECT ?? null,
        scopes: (raw.ADMIN_OIDC_SCOPES ?? "openid profile email").split(/\s+/u).filter(Boolean),
        clockSkewSeconds: raw.ADMIN_OIDC_CLOCK_SKEW_SECONDS ?? 60,
        requestTimeoutMs: raw.ADMIN_OIDC_REQUEST_TIMEOUT_MS ?? 10_000,
      }
    : null
}
