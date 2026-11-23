import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminResult, invalid, notFound, ok } from "../admin/result"
import type { CredentialCipher } from "../crypto/cipher"
import type { FetchLike } from "../dataplane"
import { bounded } from "../dataplane/attempt-log"
import { listUpstreamModels } from "../models"
import { describeProvider } from "./providers"
import type { SupportedModelsWriter } from "./supported-models-writer"

/**
 * **Ask the upstream what it serves**, and merge the answer into `supported_models`.
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
 * **It merges; it never removes.** The list is partly hand-maintained — pinned variants and ids no
 * catalogue lists — and on 2026-11-15 a discovery that *replaced* it dropped one such id, and every
 * request for it was refused `model-unsupported` for 19 hours. Now every listed id missing from the
 * list is added, every id already there is kept, and the ids the catalogue no longer lists come
 * back as `notInCatalogue`: the operator removes them, if at all, with one deliberate
 * `PATCH /:id/models`. The write goes through the one writer
 * (`./supported-models-writer.ts`), which holds the row lock, refreshes the warm catalog and audits
 * the ids that moved. This service owns the question; it does not own the row.
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
  /** False when there was nothing to merge — an empty listing is not a declaration. */
  readonly saved: boolean
  /** Listed ids this discovery added to the account's list. */
  readonly added: readonly string[]
  /**
   * Ids on the account's list that the listing did not carry. **Kept**: a catalogue that omits an
   * id is not an instruction to stop serving it. Shown so the operator can remove them on purpose.
   */
  readonly notInCatalogue: readonly string[]
  /** The account's list after the merge; `null` when it declares none (passthrough). */
  readonly supportedModels: readonly string[] | null
  /** Always safe to render: router-authored, or a `FailureClassification.signal`. */
  readonly message: string
  readonly latencyMs: number
}

export interface DiscoverModelsService {
  discover(accountId: string): Promise<AdminResult<DiscoverModelsResult>>
}

export interface DiscoverModelsServiceDeps {
  readonly accounts: Pick<AccountRepository, "findById">
  /** The one `supportedModels` writer: row lock, catalog refresh, audit. Never the repository. */
  readonly models: Pick<SupportedModelsWriter, "write">
  readonly cipher: Pick<CredentialCipher, "decrypt">
  readonly audit: AuditRecorder
  /** Bounds the one outbound call — the same ceiling a normal attempt gets. */
  readonly timeoutMs: number
  /** Injected so a test never opens a socket. Defaults to global `fetch`. */
  readonly fetch?: FetchLike
  /** Ceiling on the listing body (`MODEL_LISTING_MAX_BYTES`); absent keeps the listing default. */
  readonly maxResponseBytes?: number
  /** Where a failed listing is reported, with the upstream's own (scrubbed, bounded) words. */
  readonly log?: Pick<Logger, "warn">
  /** `LOG_REASON_MAX_CHARS`: how much of the upstream's message one line quotes. */
  readonly reasonMaxChars?: number
}

export function createDiscoverModelsService(
  deps: DiscoverModelsServiceDeps,
): DiscoverModelsService {
  const call = deps.fetch ?? ((request, init) => fetch(request, init))

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
      const declared = account.supportedModels ?? []
      await deps.audit.record({
        kind: AUDIT_KINDS.accountModelsDiscovered,
        subjectType: AUDIT_SUBJECTS.account,
        subjectId: account.id,
        // A count and a flag. The ids that moved are on the `account.supported_models_changed` row
        // the merge writes; the listing itself is not copied here.
        detail: { provider: account.provider, count: models.length, saved: models.length > 0 },
      })

      if (models.length === 0) {
        return ok({
          accountId,
          models,
          saved: false,
          added: [],
          notInCatalogue: [],
          supportedModels: account.supportedModels,
          message:
            declared.length === 0
              ? "the upstream listed no models — nothing was written, so this account still accepts any model name"
              : "the upstream listed no models — nothing was written, and the account keeps its list",
          latencyMs,
        })
      }

      const merged = await deps.models.write(
        accountId,
        { kind: "edit", add: models, remove: [] },
        "discover",
      )
      if (!merged.ok) return merged
      const listedIds = new Set(models)
      const { change } = merged.value
      const notInCatalogue = change.before.filter((id) => !listedIds.has(id))

      return ok({
        accountId,
        models,
        saved: true,
        added: change.added,
        notInCatalogue,
        supportedModels: change.after,
        message: mergedMessage(models.length, change.added.length, notInCatalogue.length),
        latencyMs,
      })
    },
  }
}

function mergedMessage(listed: number, added: number, unlisted: number): string {
  const head = `the upstream listed ${listed} model(s); ${added} added to this account's list`
  if (unlisted === 0) return head
  return `${head}; ${unlisted} id(s) on the list are not in the catalogue and were kept — remove them explicitly if they are no longer served`
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
    {
      cipher: deps.cipher,
      timeoutMs: deps.timeoutMs,
      fetch: call,
      ...(deps.maxResponseBytes === undefined ? {} : { maxResponseBytes: deps.maxResponseBytes }),
    },
    account,
  )
  if (!listed.ok) {
    // The response carries only the router's sentence; the upstream's own words are what make a
    // 400 diagnosable, and the logger scrubs them again on the way out (`logging/redact.ts`).
    deps.log?.warn("model discovery failed", {
      component: "discover-models",
      accountId: account.id,
      provider: account.provider,
      code: listed.code,
      reason: listed.message,
      ...(listed.status === undefined ? {} : { status: listed.status }),
      ...(listed.detail === undefined || deps.reasonMaxChars === undefined
        ? {}
        : { upstreamMessage: bounded(listed.detail, deps.reasonMaxChars) }),
    })
    return invalid(listed.message, listed.code)
  }
  return ok(listed.entries.map((entry) => entry.id))
}
