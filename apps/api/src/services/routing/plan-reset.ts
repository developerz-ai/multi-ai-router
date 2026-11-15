import type { QuotaWindowState } from "@multi-ai-router/core"
import { reportedReset } from "./backoff"
import type { AttemptFailure } from "./failure-kind"
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
 *
 * **Only a fresh reading lends.** A window `maxAgeMs` old or older (two `plan_quota_read` intervals:
 * one missed tick tolerated) lends nothing. A plan whose usage endpoint stopped answering, or was
 * cancelled, would otherwise keep stretching every reset-less throttle to a reset nobody re-stated.
 */
export function spentPlanReset(
  windows: readonly QuotaWindowState[],
  now: Date,
  maxAgeMs: number,
): Date | null {
  let latest: Date | null = null
  for (const window of windows) {
    if (retiredEvidence(window)) continue
    if (now.getTime() - window.lastCheckedAt.getTime() >= maxAgeMs) continue
    if (window.resetSource !== "provider-reported" || window.resetsAt === undefined) continue
    if (window.utilization === undefined || window.utilization < 1) continue
    if (window.resetsAt.getTime() <= now.getTime()) continue
    if (latest === null || window.resetsAt.getTime() > latest.getTime()) latest = window.resetsAt
  }
  return latest
}

/**
 * `failure`, its reset taken from a spent plan window when it stated none of its own.
 *
 * **A credits refusal on a spent key cap that resets is a clock.** OpenRouter answers a key past its
 * own spend `limit` with `402` / `403 Key limit exceeded`, which reads as `credits-exhausted` and
 * parked the account `exhausted` with no exit but the re-test ladder (prod: `openrouter-glm53-fallback`,
 * `exhausted` from 2026-10-08). When the key's own fresh reading (`spend_limit`, from
 * `GET /api/v1/key`) is spent and names its reset, the refusal is that cap: it becomes `rate-limited`
 * until the reset — the refusal's own stated reset first, the reading's boundary otherwise. Only that
 * window kind lends here. A spent *plan* window says nothing about a balance, and a cap with
 * headroom left, no reset, or a stale reading leaves the refusal what it was: `exhausted`, a human's.
 */
export function withPlanReset(
  failure: AttemptFailure,
  windows: readonly QuotaWindowState[],
  now: Date,
  maxAgeMs: number,
): AttemptFailure {
  if (failure.kind === "credits-exhausted") return withKeyCapReset(failure, windows, now, maxAgeMs)
  if (failure.kind !== "rate-limited") return failure
  const stated = reportedReset(failure, now) !== null && failure.resetSource !== "estimated"
  if (stated) return failure
  const planReset = spentPlanReset(windows, now, maxAgeMs)
  if (planReset === null) return failure
  const { retryAfterSeconds: _dropped, ...rest } = failure
  return { ...rest, resetsAt: planReset, resetSource: "provider-reported" }
}

function withKeyCapReset(
  failure: AttemptFailure,
  windows: readonly QuotaWindowState[],
  now: Date,
  maxAgeMs: number,
): AttemptFailure {
  const caps = windows.filter((window) => window.window === "spend_limit")
  const capReset = spentPlanReset(caps, now, maxAgeMs)
  if (capReset === null) return failure
  if (reportedReset(failure, now) !== null && failure.resetSource !== "estimated")
    return { ...failure, kind: "rate-limited" }
  const { retryAfterSeconds: _dropped, ...rest } = failure
  return { ...rest, kind: "rate-limited", resetsAt: capReset, resetSource: "provider-reported" }
}
