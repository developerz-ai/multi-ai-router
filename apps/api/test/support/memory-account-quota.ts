import type {
  AccountRepository,
  AccountRow,
  QuotaWindowRow,
  RecoveryRow,
} from "@multi-ai-router/db"

export function memoryAccountQuota(
  accounts: readonly AccountRow[],
  recoveries: ReadonlyMap<string, Pick<RecoveryRow, "generation" | "state">>,
): Pick<AccountRepository, "upsertQuotaWindow" | "upsertObservedQuotaWindow"> {
  const windows = new Map<string, QuotaWindowRow>()
  const upsertQuotaWindow: AccountRepository["upsertQuotaWindow"] = async (accountId, state) => {
    if (!accounts.some((account) => account.id === accountId)) throw new Error("account removed")
    const key = `${accountId}:${state.window}`,
      held = windows.get(key)
    const time = state.lastCheckedAt.getTime(),
      equal = held?.lastCheckedAt.getTime() === time
    const moreUsed =
      state.utilization !== undefined &&
      (held?.utilization == null || state.utilization > held.utilization)
    const laterReset =
      state.resetsAt !== undefined && (held?.resetsAt == null || state.resetsAt > held.resetsAt)
    if (
      held !== undefined &&
      (time < held.lastCheckedAt.getTime() ||
        (equal && (held.retiredAt !== null || (!moreUsed && !laterReset))))
    )
      return held
    const row: QuotaWindowRow = {
      id: held?.id ?? crypto.randomUUID(),
      accountId,
      window: state.window,
      revision: held === undefined ? 0 : held.revision + 1,
      utilization:
        held !== undefined && equal && !moreUsed ? held.utilization : (state.utilization ?? null),
      utilizationSource:
        held !== undefined && equal && !moreUsed ? held.utilizationSource : state.utilizationSource,
      resetsAt:
        held !== undefined && equal && !laterReset ? held.resetsAt : (state.resetsAt ?? null),
      resetSource:
        held !== undefined && equal && !laterReset ? held.resetSource : state.resetSource,
      lastCheckedAt: new Date(state.lastCheckedAt),
      createdAt: held?.createdAt ?? new Date(),
      retiredAt: null,
      evidenceState: "current",
      blocksRouting: true,
    }
    windows.set(key, row)
    return row
  }
  return {
    upsertQuotaWindow,
    upsertObservedQuotaWindow: async ({ accountId, state, expected }) => {
      const account = accounts.find((row) => row.id === accountId)
      if (
        account === undefined ||
        account.lifecycleVersion !== expected.lifecycleVersion ||
        account.healthRecoveryVersion !== expected.healthRecoveryVersion ||
        account.authRecoveryVersion !== expected.authRecoveryVersion ||
        account.authMaterial !== expected.authMaterial ||
        account.status !== expected.status ||
        (recoveries.get(accountId)?.generation ?? null) !== expected.recoveryGeneration
      )
        return undefined
      return upsertQuotaWindow(accountId, state)
    },
  }
}
