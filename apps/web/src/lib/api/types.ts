import type {
  AccountBilling,
  AccountStatus,
  AuthKind,
  Dialect,
  KeyScope,
  ProviderId,
  QuotaWindowKind,
  ResetSource,
  RoutingPolicy,
  UtilizationSource,
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
  /**
   * Upstream-side model ids, as declared. `null` is *unknown*, which the router reads as "accepts
   * any model name" — never as "serves nothing". What a client may actually ask for is this list
   * seen through the alias map, which is what `GET /v1/models` publishes.
   */
  readonly supportedModels: readonly string[] | null
  readonly weight: number
  readonly priority: number
  /**
   * Per-token bill or flat fee. The one input to whether this account's usage shows as spend or as
   * an attribution — it changes a cost column and nothing about routing.
   */
  readonly billing: AccountBilling
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

/**
 * `services/accounts/availability.ts` — `QuotaWindowView`.
 *
 * One row per window, never collapsed: a Claude subscription runs several on independent clocks
 * and is blocked by whichever is spent, so a single "resets at" would name one and drop the rest.
 */
export interface QuotaWindowView {
  readonly window: QuotaWindowKind
  /** `0..1`, or null where the source reported nothing — normal, not a fault. */
  readonly utilization: number | null
  readonly utilizationSource: UtilizationSource
  readonly resetsAt: string | null
  /** Always present, so a countdown is never rendered without its qualifier. */
  readonly resetSource: ResetSource
  readonly lastCheckedAt: string
  /** Computed server-side with the same function candidate filtering calls. */
  readonly spent: boolean
  /**
   * Tokens THIS ROUTER recorded inside the window's own span, or null where no ceiling is set.
   * Deliberately not folded into `utilization`: that is the provider's reading and must stay null
   * when the provider said nothing.
   */
  readonly tokensUsed: number | null
  /** The operator's configured ceiling. Not a provider fact — never reaches routing. */
  readonly tokenLimit: number | null
  /**
   * `tokensUsed` spread across equal slices of the window's span, oldest first. Empty where the
   * bar is absent.
   *
   * The same numbers as `tokensUsed`, which is their sum — so the sparkline and the bar beside it
   * cannot disagree. It answers what the total cannot: a window two-thirds spent in its first hour
   * and one two-thirds spent evenly draw the same bar and are not the same situation.
   */
  readonly tokenSeries?: readonly number[]
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
  /** Empty where the router knows of none. Absent on a write response, like the rest of this. */
  readonly quotaWindows?: readonly QuotaWindowView[]
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

/**
 * How an account of this provider is logged in. `claude-cli` drives the `claude` binary,
 * `oauth` is an authorization-code flow the router performs itself, and `null` is an API-key
 * provider where the operator pastes a credential and there is nothing to connect.
 */
export type ProviderConnectFlow = "claude-cli" | "oauth"

/** `services/accounts/providers.ts` — `ProviderDescriptor`. */
export interface ProviderDescriptor {
  readonly id: ProviderId
  readonly transport: ProviderTransport
  readonly authKind: AuthKind | null
  readonly nativeDialect: Dialect | null
  readonly supportedDialects: readonly Dialect[]
  readonly requiresBaseUrl: boolean
  readonly requiresConfigDir: boolean
  /** What a new account of this provider is billed as unless the operator says otherwise. */
  readonly defaultBilling: AccountBilling
  /**
   * True where the default is also the only answer: a provider sold only as a subscription has no
   * per-token price to meter, so the control is read-only and the API refuses the write.
   */
  readonly billingFixed: boolean
  /**
   * Which connect flow this provider takes, or null for one that takes none. Also what makes the
   * credential field optional: an account that will be logged in exists *before* its
   * authorization, so the one-shot `state` has a row to bind to.
   */
  readonly connectFlow: ProviderConnectFlow | null
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
  /** Null for a session with no expiry — a static `ADMIN_API_TOKEN`, which the console never uses. */
  readonly expiresAt: string | null
}

/** What every `DELETE` answers with. */
export interface DeletedView {
  readonly id: string
  readonly deleted: true
}
