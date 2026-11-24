import type { RejectedCandidate } from "../routing"
import { resolveModel } from "../routing"
import type { RecoveryAccess } from "./recovery-access"

/** The only refusals a recovery can clear; most of a fleet is refused as `model-unsupported`. */
const HINTED: ReadonlySet<RejectedCandidate["reason"]> = new Set([
  "probe-in-flight",
  "cooling-down",
  "quota-window-spent",
])

/** Scope was already intersected; unsupported models never create a recovery request. */
export function hintRecoveryRejections(
  rejected: readonly RejectedCandidate[],
  recovery: RecoveryAccess | undefined,
  model: string,
  now: Date,
) {
  if (recovery === undefined || rejected.length === 0) return
  const seen = new Set<string>()
  for (const refusal of rejected) {
    if (!HINTED.has(refusal.reason) || seen.has(refusal.accountId)) continue
    seen.add(refusal.accountId)
    const account = recovery.currentSnapshot(refusal.accountId)
    if (account === undefined || !resolveModel(account, model).supported) continue
    if (
      refusal.reason === "probe-in-flight" ||
      (refusal.reason === "cooling-down" && refusal.resetsAt === undefined)
    ) {
      recovery.hint(account.id, "cooldown-expired")
    } else if (refusal.reason === "quota-window-spent") {
      const window = account.quotaWindows?.find((window) => window.window === refusal.window)
      if (
        window?.resetsAt === undefined &&
        window !== undefined &&
        now.getTime() - window.lastCheckedAt.getTime() >= recovery.quotaStaleAfterMs
      ) {
        recovery.hint(account.id, "quota-stale")
      }
    }
  }
}
