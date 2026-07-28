import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminResult, invalid, notFound, ok } from "../admin/result"
import type { CredentialCipher } from "../crypto/cipher"
import type { FetchLike } from "../dataplane"
import { listUpstreamModels } from "../models"
import { describeProvider } from "./providers"
import type { AccountsService } from "./service"

/**
 * **Ask the upstream what it serves**, and write the answer into `supported_models`.
 *
 * Until this existed the column had no way to be filled except by hand, and before the column
 * existed `supportedModels` was declared by routing and populated by nothing at all — so every
 * account was a passthrough and `GET /v1/models` answered `data: []` on any deployment without an
 * alias map. A client filling a model picker from that listing saw an empty router.
 *
 * **One button, one GET, and it costs no tokens** — which is the whole reason it is not "Test now".
 * A models listing bills nothing and spends no quota window, so it carries no cooldown and no
 * confirmation. It is still a real outbound call on a real credential, so it goes through
 * `runAttempt`: same header rules, same credential handling, same failure classification, so a 401
 * here reports what a 401 on a live request would have.
 *
 * **It is not a poll, and there is no timer.** A catalog that refreshed itself would change routing
 * without an operator ever asking — an upstream retiring a model would silently take an account out
 * of selection mid-deployment. Discovery happens when a human presses the button.
 *
 * **The write goes through {@link AccountsService.update}**, not the repository: that is what keeps
 * the warm routing catalog coherent (the `withCatalogRefresh` decorator wraps it) and what audits
 * the field change. This service owns the question; it does not own the row.
 *
 * **An empty listing is never saved.** A provider that answers `data: []` — or one whose listing
 * this router cannot read — must not be allowed to turn "I know of no models" into "this account
 * serves no models", which is what writing `[]` would eventually mean to a reader who forgot that
 * empty is passthrough. Nothing is written and the operator is told what came back.
 */

const SDK_OWNS_IT =
  "a Claude subscription has no model listing endpoint — the Agent SDK owns that catalog, and the models it serves are the ones Anthropic gives the subscription"

export interface DiscoverModelsResult {
  readonly accountId: string
  /** Upstream-side ids, deduplicated and sorted. Empty when the upstream listed nothing. */
  readonly models: readonly string[]
  /** False when there was nothing to write — an empty listing is not a declaration. */
  readonly saved: boolean
  /** Always safe to render: router-authored, or a `FailureClassification.signal`. */
  readonly message: string
  readonly latencyMs: number
}

export interface DiscoverModelsService {
  discover(accountId: string): Promise<AdminResult<DiscoverModelsResult>>
}

export interface DiscoverModelsServiceDeps {
  readonly accounts: Pick<AccountRepository, "findById">
  /**
   * The decorated service, so the write refreshes the warm catalog and writes its own audit row.
   * Deliberately not the repository — see the note above.
   */
  readonly write: Pick<AccountsService, "update">
  readonly cipher: Pick<CredentialCipher, "decrypt">
  readonly audit: AuditRecorder
  /** Bounds the one outbound call — the same ceiling a normal attempt gets. */
  readonly timeoutMs: number
  /** Injected so a test never opens a socket. Defaults to global `fetch`. */
  readonly fetch?: FetchLike
}

export function createDiscoverModelsService(
  deps: DiscoverModelsServiceDeps,
): DiscoverModelsService {
  const call = deps.fetch ?? ((request: Request) => fetch(request))

  return {
    discover: async (accountId) => {
      const account = await deps.accounts.findById(accountId)
      if (account === undefined) return notFound(`no account with id "${accountId}"`)

      const descriptor = describeProvider(account.provider)
      if (descriptor.transport === "agent-sdk") {
        return invalid(`account "${account.label}": ${SDK_OWNS_IT}`, "models_not_listable")
      }
      if (descriptor.transport === "unimplemented") {
        return invalid(
          `provider "${account.provider}" has no implementation to ask`,
          "provider_unavailable",
        )
      }

      const started = performance.now()
      const listed = await listModels(deps, call, account)
      const latencyMs = Math.round(performance.now() - started)
      if (!listed.ok) return listed

      const models = listed.value
      await deps.audit.record({
        kind: AUDIT_KINDS.accountModelsDiscovered,
        subjectType: AUDIT_SUBJECTS.account,
        subjectId: account.id,
        // A count and a flag. Model ids are not credentials, but the audit log is a log of what
        // happened, not a second copy of the row the write already recorded.
        detail: { provider: account.provider, count: models.length, saved: models.length > 0 },
      })

      if (models.length === 0) {
        return ok({
          accountId,
          models,
          saved: false,
          message:
            "the upstream listed no models — nothing was written, so this account still accepts any model name",
          latencyMs,
        })
      }

      const written = await deps.write.update(accountId, { supportedModels: [...models] })
      if (!written.ok) return written

      return ok({
        accountId,
        models,
        saved: true,
        message: `the upstream listed ${models.length} model(s); this account now accepts only those`,
        latencyMs,
      })
    },
  }
}

/**
 * The one outbound call, translated into an admin result.
 *
 * The asking itself lives in `services/models/listing.ts`, shared with the hourly catalog sweep:
 * two readers of one provider listing must not be two parsers of it. This function keeps only what
 * is specific to the button — an `AdminResult` and its error codes, which the sweep has no use for.
 */
async function listModels(
  deps: DiscoverModelsServiceDeps,
  call: FetchLike,
  account: AccountRow,
): Promise<AdminResult<readonly string[]>> {
  const listed = await listUpstreamModels(
    { cipher: deps.cipher, timeoutMs: deps.timeoutMs, fetch: call },
    account,
  )
  if (!listed.ok) return invalid(listed.message, listed.code)
  return ok(listed.entries.map((entry) => entry.id))
}
