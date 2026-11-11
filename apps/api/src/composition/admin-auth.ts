import type { AuditRecorder } from "../services/admin"
import {
  adminAuthConfigFromEnv,
  createAdminAuthService,
  createLocalAdminCredentials,
} from "../services/admin-auth"
import { createOIDCFlow } from "../services/admin-auth/oidc/flow"
import type { AdminPlaneDeps } from "./admin-types"

/** The console's sign-in: session service, OIDC flow and local credential, from env. */
export function createAdminAuth(deps: AdminPlaneDeps, audit: AuditRecorder) {
  const { env, now } = deps
  return createAdminAuthService({
    env,
    store: deps.sessionStore,
    localCredentialTtlMs: env.adminCredentialMetadataTtlSeconds * 1_000,
    // The env layer speaks minutes and hours; the service speaks seconds.
    // `adminAuthConfigFromEnv` is the single conversion, so the two never drift.
    config: adminAuthConfigFromEnv({
      adminSessionIdleMinutes: env.adminAuth.sessionIdleMinutes,
      adminSessionAbsoluteHours: env.adminAuth.sessionAbsoluteHours,
      adminLoginMaxAttempts: env.adminAuth.loginMaxAttempts,
      adminLoginMaxConcurrent: env.adminAuth.loginMaxConcurrent,
      adminLoginMaxTrackedIps: env.adminAuth.loginMaxTrackedIps,
      adminLoginAttemptWindowMinutes: env.adminAuth.loginAttemptWindowMinutes,
      adminLoginLockoutMinutes: env.adminAuth.loginLockoutMinutes,
      adminSessionTouchIntervalSeconds: env.adminAuth.sessionTouchIntervalSeconds,
    }),
    // No OIDC variables means no OIDC door: the login page learns what is
    // offered from `methods()`, and the start/callback routes answer 404.
    oidc:
      env.adminOidc === null
        ? null
        : createOIDCFlow({
            requestTimeoutMs: env.adminOidc.requestTimeoutMs,
            discoveryTtlMs: env.oidcCache.discoveryTtlSeconds * 1_000,
            jwksTtlMs: env.oidcCache.jwksTtlSeconds * 1_000,
            config: {
              issuerUrl: env.adminOidc.issuerUrl,
              clientId: env.adminOidc.clientId,
              clientSecret: env.adminOidc.clientSecret,
              redirectUri: env.adminOidc.redirectUri,
              adminEmails: env.adminOidc.adminEmails,
              requiredClaims: env.adminOidc.requiredClaims,
              adminSubject: env.adminOidc.adminSubject,
              scopes: env.adminOidc.scopes,
              clockSkewSeconds: env.adminOidc.clockSkewSeconds,
            },
            stateStore: {
              // The OAuth state repository is reused — see `packages/db` for the
              // shared schema. The cipher is the same one every other admin
              // secret rides on.
              states: deps.oauthStates,
              cipher: deps.cipher,
              stateMinutes: env.retention.oauthStateMinutes,
              now,
            },
          }),
    // Always built: whether the door is open is the *row*, read live per
    // login, so `bin/admin set-password` takes effect without a restart.
    local: createLocalAdminCredentials({ repository: deps.adminCredentials }),
    audit,
  })
}
