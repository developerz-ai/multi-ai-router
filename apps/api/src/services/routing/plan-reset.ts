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
  spentAt = 1,
): Date | null {
  let latest: Date | null = null
  for (const window of windows) {
    if (retiredEvidence(window)) continue
    if (now.getTime() - window.lastCheckedAt.getTime() >= maxAgeMs) continue
    if (window.resetSource !== "provider-reported" || window.resetsAt === undefined) continue
    if (window.utilization === undefined || window.utilization < spentAt) continue
    if (window.resetsAt.getTime() <= now.getTime()) continue
    if (latest === null || window.resetsAt.getTime() > latest.getTime()) latest = window.resetsAt
  }
  return latest
}

/**
 * Utilization at or above which a `spend_limit` reading counts as the cap a refusal is about.
 *
 * Below `1` on purpose. OpenRouter refuses a request whose reserved `max_tokens` the cap's remainder
 * cannot cover, so the key answers `402` while `GET /api/v1/key` still reads under 100 %, and the
 * reading is at most one `plan_quota_read` interval old besides. Requiring a full `1` meant the
 * reset was almost never lent: prod 2026-11-23 (#441), a daily cap parked `openrouter-dz-coding-30d`
 * `exhausted` at 17:00Z, and it answered `402 needs a top-up` until 03:03Z, three hours past its own
 * 00:00Z reset. The default for {@link withPlanReset}'s `keyCapNearUtilization`; the caller's config
 * overrides it.
 */
export const DEFAULT_KEY_CAP_NEAR_UTILIZATION = 0.9

/**
 * `failure`, its reset taken from a spent plan window when it stated none of its own.
 *
 * **A credits refusal on a key cap that resets is a clock.** OpenRouter answers a key past its own
 * spend `limit` with `402` / `403 Key limit exceeded`, which reads as `credits-exhausted` and
 * parked the account `exhausted` with no exit but the re-test ladder (prod: `openrouter-glm53-fallback`,
 * `exhausted` from 2026-10-08). When the key's own fresh reading (`spend_limit`, from
 * `GET /api/v1/key`) is at or past `keyCapNearUtilization` and names its reset, the refusal is that
 * cap: it becomes `rate-limited` until the reset — the refusal's own stated reset first, the
 * reading's boundary otherwise. Only that window kind lends here. A spent *plan* window says nothing
 * about a balance, and a cap with headroom left, no reset (a `total` cap), or a stale reading leaves
 * the refusal what it was: `exhausted`, a human's.
 *
 * The same cap lends to a `rate-limited` refusal whose reset is the driver's own **estimate**
 * (`openrouter:key-limit-window`: the sentence names a resetting cap, never the instant). A
 * `rate-limited` refusal that states nothing borrows only from a window that is fully spent, as
 * before: a per-minute `429` on a key at 95 % of its daily cap is not that cap.
 */
export function withPlanReset(
  failure: AttemptFailure,
  windows: readonly QuotaWindowState[],
  now: Date,
  maxAgeMs: number,
  keyCapNearUtilization: number = DEFAULT_KEY_CAP_NEAR_UTILIZATION,
): AttemptFailure {
  if (failure.kind === "credits-exhausted")
    return withKeyCapReset(failure, windows, now, maxAgeMs, keyCapNearUtilization)
  if (failure.kind !== "rate-limited") return failure
  const stated = reportedReset(failure, now) !== null && failure.resetSource !== "estimated"
  if (stated) return failure
  const planReset =
    spentPlanReset(windows, now, maxAgeMs) ??
    (failure.resetSource === "estimated"
      ? verifiedKeyCapReset(windows, now, maxAgeMs, keyCapNearUtilization)
      : null)
  if (planReset === null) return failure
  const { retryAfterSeconds: _dropped, ...rest } = failure
  return { ...rest, resetsAt: planReset, resetSource: "provider-reported" }
}

/**
 * The fresh, provider-reported reset of a `spend_limit` key cap at or past `nearUtilization`, or
 * `null`.
 *
 * The client error path needs exactly the evidence the breaker uses above: a cap with headroom, a
 * stale or estimated reading, no reset, or a reset already past lends nothing and invents no instant.
 * Pure, with the clock, freshness bound and near-cap bound injected.
 */
export function verifiedKeyCapReset(
  windows: readonly QuotaWindowState[],
  now: Date,
  maxAgeMs: number,
  nearUtilization: number = DEFAULT_KEY_CAP_NEAR_UTILIZATION,
): Date | null {
  return spentPlanReset(
    windows.filter((window) => window.window === "spend_limit"),
    now,
    maxAgeMs,
    keyCapBound(nearUtilization),
  )
}

/** A bound outside `(0, 1]` would lend on an idle cap or never: it falls back to fully spent. */
function keyCapBound(nearUtilization: number): number {
  return Number.isFinite(nearUtilization) && nearUtilization > 0 && nearUtilization <= 1
    ? nearUtilization
    : 1
}

function withKeyCapReset(
  failure: AttemptFailure,
  windows: readonly QuotaWindowState[],
  now: Date,
  maxAgeMs: number,
  nearUtilization: number,
): AttemptFailure {
  const capReset = verifiedKeyCapReset(windows, now, maxAgeMs, nearUtilization)
  if (capReset === null) return failure
  if (reportedReset(failure, now) !== null && failure.resetSource !== "estimated")
    return { ...failure, kind: "rate-limited" }
  const { retryAfterSeconds: _dropped, ...rest } = failure
  return { ...rest, kind: "rate-limited", resetsAt: capReset, resetSource: "provider-reported" }
}
