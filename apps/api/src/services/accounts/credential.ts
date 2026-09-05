import type { AccountRepository } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import type { AccountConfigDirs } from "../../providers/claude-sdk/config-dir"
import type {
  CredentialMetadata,
  CredentialMetadataReader,
} from "../../providers/claude-sdk/credential-metadata"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import type { AdminResult } from "../admin/result"
import { describeProvider } from "./providers"
import type { AccountsService } from "./service"
import type { AccountCredentialView, AccountView } from "./view"

/**
 * Overlays when a Claude subscription's login will die onto every account read.
 *
 * A **decorator** like `./availability.ts`, applied to `list` and `get` only, and for the same
 * reason: the CRUD service has no business opening a config directory, and a write returns the row
 * it wrote. Admin plane only — the data plane never comes through here, so nothing it does touches
 * the request path.
 *
 * **Metadata, never the token** (CLAUDE.md non-negotiables 1 and 13). The reader returns four facts
 * with no field that could hold a token; this module copies three of them into the view and turns
 * the fourth into `present`. It does not refresh, forward, or use anything it read.
 *
 * **What the three answers mean.**
 * - `credential: null` — either the provider holds no `CLAUDE_CONFIG_DIR` at all, or the read
 *   *failed* (an I/O exception, a path that could not be derived). A failed read is *unknown*, not
 *   *dead*: it is logged at warn, nothing is parked, and the console shows nothing rather than a
 *   wrong thing.
 * - `present: false` — the file was read and holds no usable login: blank tokens (the CLI's own
 *   mark for an expired refresh token), a missing `claudeAiOauth`, or no file at all (never
 *   connected). Every one of those is an Account the SDK cannot use.
 * - `present: true` — both tokens are there. `expiresAt` says for how long.
 *
 * **Parking.** A `present: false` read against a row that is still `active` is a login that died
 * between probes, and it is parked through the same conditional status write the auth probe uses
 * (`accounts.updateStatusWhen(id, ["active"], "needs_reauth")`) with the same audit kind. The
 * returned view then says `needs_reauth`, so a read never shows an Account as routable when this
 * very read found it is not.
 *
 * **Cache.** One read per account per `ttlMs`, because the console polls and the file barely moves.
 * The one exception: a cached *dead* result is never trusted against an `active` row. That pairing
 * is exactly what a reconnect creates (row flipped to `active`, cache still says blank), and acting
 * on it would park the Account the operator just logged in again — so the disk is re-read instead.
 * It is also what the park decision itself keys on, so a park is never made off a stale read.
 */

export interface CredentialMetadataDeps {
  readonly reader: Pick<CredentialMetadataReader, "read">
  readonly configDirs: Pick<AccountConfigDirs, "pathFor">
  /** `ADMIN_CREDENTIAL_METADATA_TTL_SECONDS`, in ms. Config, not a constant. */
  readonly ttlMs: number
  readonly now: () => Date
  /**
   * Moves an `active` row to `needs_reauth`. Resolves `true` when the row moved, `false` when it
   * was no longer `active`. Optional: a deployment that wires none only reports.
   */
  readonly park?: (accountId: string, now: Date) => Promise<boolean>
  readonly logger?: Logger
}

interface CacheEntry {
  readonly readAt: number
  readonly value: CredentialMetadata
}

export function withCredentialMetadata(
  service: AccountsService,
  deps: CredentialMetadataDeps,
): AccountsService {
  const cache = new Map<string, CacheEntry>()

  const lookup = async (view: AccountView, now: Date): Promise<CredentialMetadata> => {
    const cached = cache.get(view.id)
    const stored = storedStatus(view)
    const fresh = cached !== undefined && now.getTime() - cached.readAt < deps.ttlMs
    if (
      cached !== undefined &&
      fresh &&
      !(cached.value.hasTokens === false && stored === "active")
    ) {
      return cached.value
    }
    const value = await deps.reader.read(deps.configDirs.pathFor(view.id))
    cache.set(view.id, { readAt: now.getTime(), value })
    return value
  }

  const overlayOne = async (view: AccountView, now: Date): Promise<AccountView> => {
    if (!describeProvider(view.provider).requiresConfigDir) return { ...view, credential: null }

    let metadata: CredentialMetadata
    try {
      metadata = await lookup(view, now)
    } catch (error) {
      // Unknown, not dead. The message names a path or an errno at most — never file contents —
      // and goes through the redactor like every other field.
      deps.logger?.warn("claude credential metadata unreadable", {
        accountId: view.id,
        reason: error instanceof Error ? error.message : String(error),
      })
      return { ...view, credential: null }
    }

    const credential = toCredentialView(metadata)
    if (credential.present || storedStatus(view) !== "active" || deps.park === undefined) {
      return { ...view, credential }
    }

    const parked = await deps.park(view.id, now)
    if (!parked) return { ...view, credential }
    deps.logger?.info("claude credential expired, account parked", {
      accountId: view.id,
      status: "needs_reauth",
    })
    return { ...view, status: "needs_reauth", credential }
  }

  const overlay = (views: readonly AccountView[]): Promise<readonly AccountView[]> => {
    const now = deps.now()
    return Promise.all(views.map((view) => overlayOne(view, now)))
  }

  return {
    ...service,
    list: async (query) => {
      const result = await service.list(query)
      return result.ok ? { ok: true, value: await overlay(result.value) } : result
    },
    get: async (id) => {
      const result: AdminResult<AccountView> = await service.get(id)
      return result.ok ? { ok: true, value: await overlayOne(result.value, deps.now()) } : result
    },
  }
}

/**
 * The status as stored, which is what the conditional park is decided against. `withAvailability`
 * may already have overlaid the live one onto `status` and kept the stored one beside it.
 */
function storedStatus(view: AccountView): AccountView["status"] {
  return view.availability?.configuredStatus ?? view.status
}

function toCredentialView(metadata: CredentialMetadata): AccountCredentialView {
  return {
    expiresAt: metadata.refreshTokenExpiresAt?.toISOString() ?? null,
    subscriptionType: metadata.subscriptionType,
    rateLimitTier: metadata.rateLimitTier,
    present: metadata.hasTokens,
  }
}

export interface CredentialParkDeps {
  readonly accounts: Pick<AccountRepository, "updateStatusWhen">
  readonly audit: AuditRecorder
  /** The warm catalog must stop selecting the row the moment the write lands — see `admin/coherence.ts`. */
  readonly refreshCatalog?: () => Promise<void>
}

/**
 * The one status write this overlay may make, shaped exactly like the auth probe's: `active` →
 * `needs_reauth`, guarded in the statement so an operator's `disabled` is never overwritten, and
 * audited as an ordinary `account.updated` naming the reason — no kind invented for one writer.
 */
export function createCredentialPark(
  deps: CredentialParkDeps,
): (accountId: string, now: Date) => Promise<boolean> {
  return async (accountId, now) => {
    const row = await deps.accounts.updateStatusWhen(accountId, ["active"], "needs_reauth", now)
    if (row === undefined) return false

    await deps.audit.record({
      kind: AUDIT_KINDS.accountUpdated,
      subjectType: AUDIT_SUBJECTS.account,
      subjectId: row.id,
      // Names and flags only. Which file said so is the whole detail; nothing in it is read back.
      detail: {
        provider: row.provider,
        source: "credential_metadata",
        status: "needs_reauth",
        previousStatus: "active",
        reason: "refresh token expired: the claude CLI has blanked this account's tokens",
      },
    })
    await deps.refreshCatalog?.()
    return true
  }
}
