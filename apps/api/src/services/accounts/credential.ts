import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import type { AccountConfigDirs } from "../../providers/claude-sdk/config-dir"
import type {
  CredentialMetadata,
  CredentialMetadataReader,
} from "../../providers/claude-sdk/credential-metadata"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import type { AdminResult } from "../admin/result"
import type { LastLoginLookup } from "./last-login"
import { computeLoginLifetime, type LoginLifetimePolicy } from "./login-lifetime"
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
 *   mark for a refresh it could not complete — an expired refresh token, or one already spent by a
 *   concurrent subprocess, which is the failure `credential-freshness.ts` exists to prevent), a
 *   missing `claudeAiOauth`, or no file at all (never connected). Every one of those is an Account
 *   the SDK cannot use.
 * - `present: true` — both tokens are there. `refreshTokenExpiresAt` says how long the *login*
 *   has; the access token's own `expiresAt` is a separate, much shorter clock, and the one
 *   `providers/claude-sdk/credential-freshness.ts` serializes around.
 *
 * **Parking.** Private durable facts are captured before opening the metadata file. A blank
 * result parks only the exact active lifecycle and ciphertext observed, so a delayed read cannot
 * undo reconnect or operator intent. Cached metadata is scoped to those same facts. The public
 * view carries none of them. List captures all private rows in one admin-plane query.
 */

export interface CredentialMetadataDeps {
  readonly accounts: Pick<AccountRepository, "findById" | "findByIds">
  readonly reader: Pick<CredentialMetadataReader, "read">
  readonly configDirs: Pick<AccountConfigDirs, "pathFor">
  /** `ADMIN_CREDENTIAL_METADATA_TTL_SECONDS`, in ms. Config, not a constant. */
  readonly ttlMs: number
  readonly now: () => Date
  /**
   * Moves an `active` row to `needs_reauth`. Resolves `true` when the row moved, `false` when it
   * was no longer `active`. Optional: a deployment that wires none only reports.
   */
  readonly park?: (observed: AccountRow, now: Date) => Promise<boolean>
  readonly logger?: Logger
  /**
   * Login lifetime: the last interactive login per account (one audit query per read) and the
   * configured assumed lifetime + warn window. Timestamps only — `login-lifetime.ts`.
   */
  readonly lifetime: {
    readonly lastLogins: LastLoginLookup
    readonly policy: LoginLifetimePolicy
    readonly warnDays: number
  }
}

interface CacheEntry {
  readonly observation: Pick<AccountRow, "lifecycleVersion" | "authMaterial" | "status">
  readonly readAt: number
  readonly value: CredentialMetadata
}

export function withCredentialMetadata(
  service: AccountsService,
  deps: CredentialMetadataDeps,
): AccountsService {
  const cache = new Map<string, CacheEntry>()

  const owners = new Map<string, object>()
  const lookup = async (observed: AccountRow, now: Date): Promise<CredentialMetadata> => {
    const cached = cache.get(observed.id)
    const same =
      cached !== undefined &&
      cached.observation.lifecycleVersion === observed.lifecycleVersion &&
      cached.observation.authMaterial === observed.authMaterial &&
      cached.observation.status === observed.status
    if (
      cached !== undefined &&
      same &&
      now.getTime() - cached.readAt < deps.ttlMs &&
      !(cached.value.hasTokens === false && observed.status === "active")
    )
      return cached.value

    const owner = {}
    owners.set(observed.id, owner)
    try {
      const value = await deps.reader.read(deps.configDirs.pathFor(observed.id))
      if (owners.get(observed.id) === owner) {
        cache.set(observed.id, {
          readAt: now.getTime(),
          value,
          observation: {
            lifecycleVersion: observed.lifecycleVersion,
            authMaterial: observed.authMaterial,
            status: observed.status,
          },
        })
      }
      return value
    } finally {
      if (owners.get(observed.id) === owner) owners.delete(observed.id)
    }
  }

  // A failed audit read degrades the estimate to `unknown`; it never fails the account read.
  const loginsFor = async (ids: readonly string[]): Promise<ReadonlyMap<string, Date>> => {
    if (ids.length === 0) return new Map()
    try {
      return await deps.lifetime.lastLogins(ids)
    } catch (error) {
      deps.logger?.warn("last interactive login unreadable", {
        reason: error instanceof Error ? error.message : String(error),
      })
      return new Map()
    }
  }

  const overlayOne = async (
    view: AccountView,
    observed: AccountRow | undefined,
    now: Date,
    lastLoginAt: Date | null,
  ): Promise<AccountView> => {
    if (!describeProvider(view.provider).requiresConfigDir || observed === undefined) {
      return { ...view, credential: null }
    }

    let metadata: CredentialMetadata
    try {
      metadata = await lookup(observed, now)
    } catch (error) {
      // Unknown, not dead. The message names a path or an errno at most — never file contents —
      // and goes through the redactor like every other field.
      deps.logger?.warn("claude credential metadata unreadable", {
        accountId: view.id,
        reason: error instanceof Error ? error.message : String(error),
      })
      return { ...view, credential: null }
    }

    const credential = toCredentialView(metadata, lastLoginAt, now, deps.lifetime)
    if (credential.present || observed.status !== "active" || deps.park === undefined) {
      return { ...view, credential }
    }

    const parked = await deps.park(observed, now)
    if (!parked) return { ...view, credential }
    deps.logger?.info("claude credential expired, account parked", {
      accountId: view.id,
      status: "needs_reauth",
    })
    return { ...view, status: "needs_reauth", credential }
  }

  const overlay = async (views: readonly AccountView[]): Promise<readonly AccountView[]> => {
    const now = deps.now()
    const ids = views
      .filter((view) => describeProvider(view.provider).requiresConfigDir)
      .map((view) => view.id)
    const rows = ids.length === 0 ? [] : await deps.accounts.findByIds(ids)
    const captured = new Map(rows.map((row) => [row.id, row]))
    const logins = await loginsFor(ids)
    return Promise.all(
      views.map((view) =>
        overlayOne(view, captured.get(view.id), now, logins.get(view.id) ?? null),
      ),
    )
  }

  return {
    ...service,
    list: async (query) => {
      const result = await service.list(query)
      return result.ok ? { ok: true, value: await overlay(result.value) } : result
    },
    get: async (id) => {
      const result: AdminResult<AccountView> = await service.get(id)
      if (!result.ok) return result
      const subscription = describeProvider(result.value.provider).requiresConfigDir
      const observed = subscription ? await deps.accounts.findById(id) : undefined
      const logins = await loginsFor(subscription ? [id] : [])
      return {
        ok: true,
        value: await overlayOne(result.value, observed, deps.now(), logins.get(id) ?? null),
      }
    },
  }
}

/** Copies instants and flags only — the metadata type has no field that could hold a token. */
function toCredentialView(
  metadata: CredentialMetadata,
  lastLoginAt: Date | null,
  now: Date,
  lifetime: CredentialMetadataDeps["lifetime"],
): AccountCredentialView {
  const login = computeLoginLifetime({ metadata, lastLoginAt, now, policy: lifetime.policy })
  return {
    expiresAt: metadata.refreshTokenExpiresAt?.toISOString() ?? null,
    subscriptionType: metadata.subscriptionType,
    rateLimitTier: metadata.rateLimitTier,
    present: metadata.hasTokens,
    accessTokenExpiresAt: login.accessTokenExpiresAt?.toISOString() ?? null,
    lastLoginAt: login.lastLoginAt?.toISOString() ?? null,
    renewsAt: login.renewsAt?.toISOString() ?? null,
    renewsAtSource: login.source,
    daysUntilRenewal: login.daysUntilRenewal,
    renewalRequiredSoon: login.renewalRequiredSoon,
    renewalWarnDays: lifetime.warnDays,
  }
}

export interface CredentialParkDeps {
  readonly accounts: Pick<AccountRepository, "transitionObservedStatus">
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
): (observed: AccountRow, now: Date) => Promise<boolean> {
  return async (observed, now) => {
    if (observed.status !== "active") return false
    const row = await deps.accounts.transitionObservedStatus({
      id: observed.id,
      expected: {
        lifecycleVersion: observed.lifecycleVersion,
        authMaterial: observed.authMaterial,
        status: observed.status,
      },
      status: "needs_reauth",
      now,
    })
    if (row === undefined) return false

    await deps.refreshCatalog?.()
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
        // Deliberately does not claim the refresh token expired. The 2026-09-06 incident blanked
        // three Accounts whose refresh tokens had a month left: a rejected refresh looks exactly
        // like an expired one from here, and only the file's own expiry can tell them apart.
        reason:
          "the claude CLI has blanked this account's tokens; it needs an interactive re-login",
      },
    })
    return true
  }
}
