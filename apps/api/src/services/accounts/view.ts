import type { AccountStatus, Dialect, ProviderId } from "@multi-ai-router/core"
import type { AccountRow, ModelAliasMap } from "@multi-ai-router/db"
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
 * `configDir` is a filesystem path, not a credential — the operator picked it
 * and needs to see which directory an account owns. Its *contents* are live
 * credential material and are never read by this layer.
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
  readonly weight: number
  readonly priority: number
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
    weight: row.weight,
    priority: row.priority,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
