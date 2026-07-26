/**
 * The admin authentication plane's public surface. Transport imports from here; nothing else
 * reaches inside the directory.
 */

export {
  type AdminAuthConfig,
  type AdminAuthEnvConfig,
  adminAuthConfigFromEnv,
  DEFAULT_ADMIN_AUTH_CONFIG,
  DEFAULT_ADMIN_AUTH_ENV,
  resolveAdminAuthConfig,
} from "./config"
/**
 * Exported for the data plane's router-key verification, which compares a decrypted key against
 * the presented one under the same rule. One implementation, never a second, weaker copy —
 * docs/reusable-code.md, "Things that must never be duplicated".
 */
export { timingSafeEqualStrings } from "./constantTime"
export {
  SESSION_COOKIE_NAME,
  type SessionCookieOptions,
  sessionCookieFullName,
  sessionCookieOptions,
  sessionCookiePrefix,
} from "./cookies"
export { CSRF_HEADER, isMutatingMethod } from "./csrf"
export {
  type AdminAuthDeps,
  type AdminAuthService,
  createAdminAuthService,
  type LoginInput,
  type LoginResult,
} from "./service"
export {
  type AdminSession,
  createMemorySessionStore,
  type SessionStore,
  sessionExpiryMs,
} from "./sessionStore"
