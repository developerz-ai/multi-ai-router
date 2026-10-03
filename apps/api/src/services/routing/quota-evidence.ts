import type { QuotaWindowState } from "@multi-ai-router/core"
export interface QuotaEvidence extends QuotaWindowState {
  readonly revision?: number
  readonly retiredAt?: Date
  readonly evidenceState?: "current" | "expired" | "superseded_by_recovery"
  readonly blocksRouting?: boolean
}
export function retiredEvidence(window: QuotaEvidence): boolean {
  return (
    window.retiredAt !== undefined ||
    window.blocksRouting === false ||
    (window.evidenceState !== undefined && window.evidenceState !== "current")
  )
}
/** Provider clocks order readings; durable revisions order same-clock retirement/current state. */
export function mergeQuotaEvidence(held: QuotaEvidence, incoming: QuotaEvidence): QuotaEvidence {
  const clock = incoming.lastCheckedAt.getTime() - held.lastCheckedAt.getTime()
  if (clock !== 0) return clock > 0 ? incoming : held
  if (
    held.revision !== undefined &&
    incoming.revision !== undefined &&
    held.revision !== incoming.revision
  )
    return incoming.revision > held.revision ? incoming : held
  if (retiredEvidence(held)) return held
  if (retiredEvidence(incoming)) return incoming
  const moreUsed =
    incoming.utilization !== undefined &&
    (held.utilization === undefined || incoming.utilization > held.utilization)
  const laterReset =
    incoming.resetsAt !== undefined &&
    (held.resetsAt === undefined || incoming.resetsAt > held.resetsAt)
  if (!moreUsed && !laterReset) return held
  const merged = {
    ...held,
    ...(moreUsed
      ? { utilization: incoming.utilization, utilizationSource: incoming.utilizationSource }
      : {}),
    ...(laterReset ? { resetsAt: incoming.resetsAt, resetSource: incoming.resetSource } : {}),
  }
  // New local facts cannot masquerade as the old persisted revision a permit captured.
  if (incoming.revision === undefined) {
    delete merged.revision
    delete merged.retiredAt
    delete merged.evidenceState
    delete merged.blocksRouting
  }
  return merged
}
export function toQuotaEvidence(row: {
  window: QuotaWindowState["window"]
  utilization: number | null
  utilizationSource: QuotaWindowState["utilizationSource"]
  resetsAt: Date | null
  resetSource: QuotaWindowState["resetSource"]
  lastCheckedAt: Date
  revision: number
  retiredAt: Date | null
  evidenceState: "current" | "expired" | "superseded_by_recovery"
  blocksRouting: boolean
}): QuotaEvidence {
  return {
    window: row.window,
    utilizationSource: row.utilizationSource,
    resetSource: row.resetSource,
    lastCheckedAt: row.lastCheckedAt,
    revision: row.revision,
    evidenceState: row.evidenceState,
    blocksRouting: row.blocksRouting,
    ...(row.utilization === null ? {} : { utilization: row.utilization }),
    ...(row.resetsAt === null ? {} : { resetsAt: row.resetsAt }),
    ...(row.retiredAt === null ? {} : { retiredAt: row.retiredAt }),
  }
}
/** Expired facts are unknown capacity, never a fabricated zero-utilization reading. */
export function continuousQuotaHeadroom(
  account: {
    quotaWindows?: readonly QuotaEvidence[]
    limiterWindows?: readonly { utilization?: number; utilizationSource: string; resetsAt?: Date }[]
  },
  now: Date,
): number | null {
  let peak: number | undefined
  for (const window of [...(account.quotaWindows ?? []), ...(account.limiterWindows ?? [])]) {
    if (
      retiredEvidence(window as QuotaEvidence) ||
      window.utilizationSource !== "continuous" ||
      window.utilization === undefined ||
      (window.resetsAt !== undefined && window.resetsAt <= now)
    )
      continue
    peak = Math.max(peak ?? window.utilization, window.utilization)
  }
  return peak === undefined ? null : 1 - peak
}
