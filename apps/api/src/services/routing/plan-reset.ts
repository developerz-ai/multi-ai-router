import type { QuotaWindowState } from "@multi-ai-router/core"
import { reportedReset } from "./backoff"
import type { AttemptFailure } from "./failover"
import { retiredEvidence } from "./quota-evidence"

/**
 * **A limit refusal that names no reset borrows the one the plan's own reading names.** Pure.
 *
 * MiniMax's `2056` and Kimi's weekly `403` say a plan window is spent and never say until when, so
 * the breaker filled the gap with its backoff, capped at five minutes: a weekly window spent on a
 * Friday was re-probed every five minutes until Monday (prod, 2026-11-06: 92 straight failures on
 * the `minimax` account, each a `429` some request or recheck walked into). Those same plans answer
 * a usage endpoint (`plan_quota_read`), which states each window's utilization and the instant it
 * reopens. Both together are the provider's own answer: the refusal says *now*, the reading says
 * *until when*.
 *
 * Two keys, never one. The reading alone never cools an Account — it is advisory, and a plan with
 * Credits behind it serves past a spent window; only a real `rate-limited` failure starts the
 * cooldown, and this only says how long it is. A stated reset — header, `Retry-After`, z.ai's
 * message stamp — always stands: only a missing one, or our own `estimated` re-test cadence, is
 * replaced.
 *
 * The latest reset among the spent windows, because the account serves again only once every spent
 * window has reopened. The exit stays the one every long cooldown has: the reset itself, and the
 * hourly `cooldown_recheck` for a window the provider reopens early.
 */
export function spentPlanReset(windows: readonly QuotaWindowState[], now: Date): Date | null {
  let latest: Date | null = null
  for (const window of windows) {
    if (retiredEvidence(window)) continue
    if (window.resetSource !== "provider-reported" || window.resetsAt === undefined) continue
    if (window.utilization === undefined || window.utilization < 1) continue
    if (window.resetsAt.getTime() <= now.getTime()) continue
    if (latest === null || window.resetsAt.getTime() > latest.getTime()) latest = window.resetsAt
  }
  return latest
}

/** `failure`, its reset taken from a spent plan window when it stated none of its own. */
export function withPlanReset(
  failure: AttemptFailure,
  windows: readonly QuotaWindowState[],
  now: Date,
): AttemptFailure {
  if (failure.kind !== "rate-limited") return failure
  const stated = reportedReset(failure, now) !== null && failure.resetSource !== "estimated"
  if (stated) return failure
  const planReset = spentPlanReset(windows, now)
  if (planReset === null) return failure
  const { retryAfterSeconds: _dropped, ...rest } = failure
  return { ...rest, resetsAt: planReset, resetSource: "provider-reported" }
}
