import type { LocalAdminCredentials } from "./localCredential"

/**
 * Whether a session's principal is still one this deployment admits — re-asked on every
 * authenticated request, because a session row outlives the configuration that minted it.
 * Removing the local password or dropping an email from `ADMIN_OIDC_ADMIN_EMAIL` must end the
 * sessions it admitted, not leave them alive for the 30-day absolute window.
 *
 * Pure over what the caller already holds in memory: no query per request.
 */
export function sessionPrincipalAdmitted(
  username: string,
  admits: {
    readonly localUsername: string
    readonly localConfigured: boolean
    /** Null when OIDC is not configured at all: no email session is admitted. */
    readonly oidc: { readonly adminEmails: readonly string[] | null } | null
  },
): boolean {
  if (username === admits.localUsername) return admits.localConfigured
  if (admits.oidc === null) return false
  // A claims-only gate (`ADMIN_OIDC_REQUIRED_CLAIMS` without an email list) cannot be re-checked
  // without the id_token, which is not kept; such a session lives to its expiry or a revoke.
  if (admits.oidc.adminEmails === null) return true
  return admits.oidc.adminEmails.includes(username.toLowerCase())
}

export interface CachedLocalConfigured {
  /** The last answer younger than the TTL, else one shared read of the credential row. */
  get(): Promise<boolean>
  /** Records an answer the caller learned for free — a successful password check. */
  remember(configured: boolean): void
}

/**
 * `isConfigured()` is a row read. `/methods`, both OIDC routes and every session check ask it, so
 * uncached it was one unauthenticated query per hit. Bounded staleness instead: a `bin/admin`
 * verb takes effect within `ttlMs`.
 */
export function createCachedLocalConfigured(
  local: LocalAdminCredentials | null | undefined,
  ttlMs: number,
  now: () => number,
): CachedLocalConfigured {
  let cached: { configured: boolean; atMs: number } | null = null
  let pending: Promise<boolean> | null = null

  return {
    async get() {
      if (local == null) return false
      if (cached !== null && now() - cached.atMs < ttlMs) return cached.configured
      if (pending === null) {
        pending = local
          .isConfigured()
          .then((configured) => {
            cached = { configured, atMs: now() }
            return configured
          })
          .finally(() => {
            pending = null
          })
      }
      return pending
    },
    remember(configured) {
      cached = { configured, atMs: now() }
    },
  }
}
