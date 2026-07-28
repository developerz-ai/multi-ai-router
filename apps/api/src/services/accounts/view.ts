import type {
  AccountBilling,
  AccountStatus,
  Dialect,
  ProviderId,
  WindowTokenLimits,
} from "@multi-ai-router/core"
import type { AccountRow, ModelAliasMap, SupportedModelList } from "@multi-ai-router/db"
import type { AccountAvailability } from "./availability"

/**
 * What the admin plane is allowed to say about an account.
 *
 * **`authMaterial` is absent, and there is no field that could carry it.** Not
 * a masked one, not a "last 4", not a length. The stored value is an AES-256-GCM
 * envelope and the only code that decrypts it is the request path that has to
 * present it upstream — CLAUDE.md non-negotiable 3, and docs/idea/04's flat
 * "See an upstream credential: no endpoint returns one, on either plane."
 *
 * `hasCredential` is the display hint the console needs and the most that can be
 * said: whether the account holds one at all, which is what distinguishes a
 * configured account from a half-finished one. It is derived, never stored.
 *
 * `configDir` is a filesystem path, not a credential. The router picked it —
 * `<CLAUDE_CONFIG_ROOT>/<id>` — and the operator still needs to see which
 * directory an account owns, to back it up or to look at it on the volume. Its
 * *contents* are live credential material and are never read by this layer.
 */
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
  readonly modelAliases: ModelAliasMap | null
  /**
   * Upstream-side model ids, as declared. `null` is *unknown*, which routing reads as passthrough
   * — not "serves nothing". What a client may actually **ask** for is this list filtered through
   * the alias map, which is what `GET /v1/models` publishes (`services/routing/model.ts`).
   */
  readonly supportedModels: SupportedModelList | null
  /**
   * Operator-set token ceilings per quota window. Null where none were configured.
   *
   * Rendered as a progress bar labelled *configured* — never as a provider reading, because
   * Anthropic publishes no numeric limit and this is the operator's own estimate.
   */
  readonly windowTokenLimits: WindowTokenLimits | null
  readonly weight: number
  readonly priority: number
  /**
   * Per-token bill or flat fee — the one input to whether this account's usage is reported as spend
   * or as an attribution. Not a credential fact and not a routing one: it changes a cost column and
   * nothing else.
   */
  readonly billing: AccountBilling
  readonly tokenExpiresAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
  /**
   * What the router currently observes: live reset instant, how trustworthy it is, and when an
   * operator last re-checked. Added by the `withAvailability` decorator on reads, and absent on
   * a write — which returns the row just written, not a fresh observation of it.
   */
  readonly availability?: AccountAvailability
}

export function toAccountView(row: AccountRow): AccountView {
  return {
    id: row.id,
    label: row.label,
    provider: row.provider,
    status: row.status,
    hasCredential: row.authMaterial !== null,
    configDir: row.configDir,
    baseUrl: row.baseUrl,
    dialect: row.dialect ?? null,
    modelAliases: row.modelAliases,
    supportedModels: row.supportedModels,
    windowTokenLimits: row.windowTokenLimits ?? null,
    weight: row.weight,
    priority: row.priority,
    billing: row.billing,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
