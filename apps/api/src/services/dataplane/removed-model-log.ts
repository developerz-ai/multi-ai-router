import type { RouterError } from "@multi-ai-router/core"
import type { Logger } from "../../logging/logger"
import type { SelectionFailure } from "../routing"

/**
 * One `warn` line per refused request whose model was on an account's list until recently: which
 * id, which account, when it left and who removed it. The refusal's own sentence says the same
 * (`routing/no-candidates-wording.ts`); this is the line a log search for the account finds.
 * Refusal path only — a served request writes nothing here (non-negotiable 8). Returns the refusal,
 * so the dispatcher logs and fails in one step.
 */
export function logRemovedModelRefusal(
  log: Pick<Logger, "warn"> | undefined,
  refused: SelectionFailure,
  model: string,
): RouterError {
  for (const entry of refused.decision.rejected) {
    const removed = entry.removedFromList
    if (entry.reason !== "model-unsupported" || removed === undefined) continue
    log?.warn("model refused: removed from the account's supported models", {
      component: "dataplane",
      model,
      accountId: entry.accountId,
      label: entry.label,
      removedModel: removed.model,
      removedAt: removed.at.toISOString(),
      removedBy: removed.by,
    })
  }
  return refused.error
}
