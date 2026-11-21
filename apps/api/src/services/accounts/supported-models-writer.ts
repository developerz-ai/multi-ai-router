import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder, UNKNOWN_ACTOR } from "../admin/audit"
import { currentAuditContext } from "../admin/audit-context"
import { type AdminResult, conflict, invalid, notFound, ok } from "../admin/result"
import {
  isNoop,
  planSupportedModelsEdit,
  type SupportedModelsChange,
  type SupportedModelsEdit,
  type SupportedModelsPlan,
  type SupportedModelsRefusal,
} from "./supported-models"

/**
 * The one door every `supportedModels` change goes through: "Discover models", the add/remove
 * operation, the full replace and the account `PATCH` all call {@link SupportedModelsWriter.write}.
 * The rule is `planSupportedModelsEdit` (`./supported-models.ts`); this module runs it under the
 * row lock, then makes the change land on the request path, audits it and logs it.
 *
 * **Every change is audited** as `account.supported_models_changed` with the ids added and removed
 * and what made the change (`source`); the caller comes from the audit context. A write that
 * changes nothing writes no row, no audit event and no log line.
 */

/** What asked for the change — recorded on the audit row so "why did this id go" has an answer. */
export type SupportedModelsSource =
  | "discover"
  | "operator-edit"
  | "operator-replace"
  | "account-update"

export interface SupportedModelsWrite {
  readonly row: AccountRow
  readonly change: SupportedModelsChange
}

export interface SupportedModelsWriter {
  write(
    accountId: string,
    edit: SupportedModelsEdit,
    source: SupportedModelsSource,
  ): Promise<AdminResult<SupportedModelsWrite>>
}

export interface SupportedModelsWriterDeps {
  readonly accounts: Pick<AccountRepository, "editSupportedModels">
  readonly audit: AuditRecorder
  readonly now: () => Date
  /** `MODEL_REMOVAL_MEMORY_DAYS` in ms: how long a removal stays explainable. */
  readonly memoryMs: number
  /** Awaited after a committed write, before audit — the warm routing catalog refresh. */
  readonly mutationCommitted?: (accountId: string) => Promise<void>
  readonly log?: Pick<Logger, "info">
}

export function createSupportedModelsWriter(
  deps: SupportedModelsWriterDeps,
): SupportedModelsWriter {
  return {
    write: async (accountId, edit, source) => {
      const now = deps.now()
      const by = actorName()
      let plan: SupportedModelsPlan | undefined
      const result = await deps.accounts.editSupportedModels({
        id: accountId,
        now,
        decide: (row) => {
          plan = planSupportedModelsEdit(row, edit, { now, by, memoryMs: deps.memoryMs })
          if (!plan.ok || isNoop(plan.change)) return { kind: "skip" }
          return {
            kind: "write",
            supportedModels: plan.change.after === null ? null : [...plan.change.after],
            supportedModelsRemoved: plan.removals,
          }
        },
      })
      if (result.kind === "not_found" || plan === undefined)
        return notFound(`no account with id "${accountId}"`)
      if (!plan.ok) return refused(result.row.label, plan.refusal)
      if (result.kind === "skipped") return ok({ row: result.row, change: plan.change })

      const { change } = plan
      await deps.mutationCommitted?.(accountId)
      await deps.audit.record({
        kind: AUDIT_KINDS.accountSupportedModelsChanged,
        subjectType: AUDIT_SUBJECTS.account,
        subjectId: accountId,
        // Model ids are not credentials. The full list is the row's; what moved exists only here.
        detail: {
          label: result.row.label,
          source,
          added: change.added,
          removed: change.removed,
          count: change.after?.length ?? 0,
        },
      })
      deps.log?.info("account supported models changed", {
        component: "supported-models",
        accountId,
        label: result.row.label,
        source,
        by,
        added: change.added,
        removed: change.removed,
      })
      return ok({ row: result.row, change })
    },
  }
}

/** The name a removal is remembered under: the audit actor, plus what it declared itself to be. */
function actorName(): string {
  const caller = currentAuditContext()
  if (caller === undefined) return UNKNOWN_ACTOR
  return caller.says === null ? caller.actor : `${caller.actor} (${caller.says})`
}

function refused(label: string, refusal: SupportedModelsRefusal): AdminResult<never> {
  if (refusal.kind === "contradictory_edit")
    return invalid(
      `account "${label}": ${quoted(refusal.models)} cannot be both added and removed in one edit`,
      "supported_models_contradictory_edit",
    )
  return conflict(
    `account "${label}": this replacement would remove ${refusal.unnamed.length} model id(s) it does not name in "removing": ${quoted(refusal.unnamed)}. Name every id you mean to remove, or add and remove single ids with PATCH /api/admin/accounts/:id/models — a list read before another edit cannot drop an id it never saw.`,
    "supported_models_removal_unacknowledged",
  )
}

function quoted(ids: readonly string[]): string {
  return ids.map((id) => `"${id}"`).join(", ")
}

/**
 * The account `PATCH`'s `supportedModels` as the guarded replace, `supportedModelsRemoving` naming
 * what it drops. `null` when the body carries no list, so the caller writes its other fields alone.
 */
export async function replaceFromPatch(
  writer: Pick<SupportedModelsWriter, "write">,
  accountId: string,
  body: {
    readonly supportedModels?: readonly string[] | null
    readonly supportedModelsRemoving?: readonly string[]
  },
): Promise<AdminResult<SupportedModelsWrite> | null> {
  if (body.supportedModels === undefined) return null
  const removing = body.supportedModelsRemoving ?? []
  const edit = { kind: "replace" as const, models: body.supportedModels, removing }
  return writer.write(accountId, edit, "account-update")
}
