import type {
  AccountStatus,
  AuthKind,
  Dialect,
  KeyScope,
  ProviderId,
  ResetSource,
  RoutingPolicy,
} from "@multi-ai-router/core"

// The wire shapes of `/api/admin/**`, declared **here** rather than imported
// from `apps/api`. The SPA is a separate deployable that talks HTTP; importing
// across the app boundary would compile the server's module graph into the
// browser bundle and make a private service type part of the public contract.
//
// The *vocabulary* is still shared — `AccountStatus`, `ProviderId`,
// `RoutingPolicy`, `KeyScope`, `Dialect` come from `@multi-ai-router/core` as
// types only, so a status added upstream fails this build rather than silently
// falling through a `default` branch.
//
// Provenance: `apps/api/src/services/{accounts,pools,keys}/view.ts` and
// `services/accounts/providers.ts`. Blast radius if the API changes a field:
// this file plus whichever cell renders it.

/** `services/accounts/view.ts` — `AccountView`. No field carries credential material. */
export interface AccountView {
  readonly id: string
  readonly label: string
  readonly provider: ProviderId
  readonly status: AccountStatus
  /** Whether a credential is stored. Never the credential, in any form. */
  readonly hasCredential: boolean
  readonly configDir: string | null
  readonly baseUrl: string | null
  readonly dialect: Dialect | null
  readonly modelAliases: Readonly<Record<string, string>> | null
  readonly weight: number
  readonly priority: number
  readonly tokenExpiresAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
  /**
   * What the router currently observes, overlaid on the read by the API.
   *
   * Absent on a write response, which returns the row just written rather than a fresh
   * observation of it — so every consumer must treat it as optional.
   */
  readonly availability?: AccountAvailability
}

/** `services/accounts/availability.ts` — `AccountAvailability`. */
export interface AccountAvailability {
  /** What the operator set: `active` or `disabled`, never an observation. */
  readonly configuredStatus: AccountStatus
  readonly resetsAt: string | null
  /** Always present, so a countdown is never rendered without its qualifier. */
  readonly resetSource: ResetSource
  readonly lastCheckedAt: string | null
  readonly consecutiveFailures: number
  readonly inFlight: number
}

/** `services/pools/view.ts` — `PoolMemberView`. */
export interface PoolMemberView {
  readonly accountId: string
  readonly label: string
  readonly provider: ProviderId
  readonly status: AccountStatus
  readonly weight: number
  readonly priority: number
}

export interface PoolView {
  readonly id: string
  readonly name: string
  readonly policy: RoutingPolicy
  readonly overflowAccountId: string | null
  readonly members: readonly PoolMemberView[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** `services/keys/view.ts` — `KeyRateLimitView`. Both halves or neither. */
export interface KeyRateLimitView {
  readonly requests: number
  readonly windowSeconds: number
}

export interface KeyScopeView {
  readonly kind: KeyScope
  readonly poolIds: readonly string[]
  readonly accountIds: readonly string[]
}

export interface ApiKeyView {
  readonly id: string
  readonly name: string
  /** The clear, indexed display prefix. The list never carries the full value. */
  readonly prefix: string
  readonly scope: KeyScopeView
  readonly rateLimit: KeyRateLimitView | null
  readonly expiresAt: string | null
  readonly revoked: boolean
  readonly revokedAt: string | null
  readonly lastUsedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * What `POST /keys/:id/reveal` answers with. Keys are encrypted, not hashed,
 * and re-readable by design — there is no shown-once flow to implement here.
 */
export interface RevealedKey {
  readonly id: string
  readonly name: string
  readonly value: string
}

/** The mint returns the view *and* the value in one body. */
export type MintedKey = ApiKeyView & { readonly value: string }

export type ProviderTransport = "http" | "agent-sdk" | "unimplemented"

/** `services/accounts/providers.ts` — `ProviderDescriptor`. */
export interface ProviderDescriptor {
  readonly id: ProviderId
  readonly transport: ProviderTransport
  readonly authKind: AuthKind | null
  readonly nativeDialect: Dialect | null
  readonly supportedDialects: readonly Dialect[]
  readonly requiresBaseUrl: boolean
  readonly requiresConfigDir: boolean
  readonly creatable: boolean
  readonly reason: string | null
}

/** `GET /providers` is the one list endpoint that wraps its array. */
export interface ProviderListResponse {
  readonly providers: readonly ProviderDescriptor[]
}

/** `routes/admin/auth.ts` — the body of `POST /login` and `GET /session`. */
export interface SessionView {
  readonly username: string
  readonly csrfToken: string
  readonly issuedAt: string
  readonly expiresAt: string
}

/** What every `DELETE` answers with. */
export interface DeletedView {
  readonly id: string
  readonly deleted: true
}
