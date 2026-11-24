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
 * Utilization at or above which a `spend_limit` reading counts as the cap **a refusal that names a
 * resetting key cap** is about.
 *
 * Below `1` on purpose. OpenRouter refuses a request whose reserved `max_tokens` the cap's remainder
 * cannot cover, so the key answers `402 … create a key with a higher daily limit` while
 * `GET /api/v1/key` still reads under 100 %, and the reading is at most one `plan_quota_read`
 * interval old besides. Prod 2026-11-23 (#441): a daily cap parked `openrouter-dz-coding-30d`
 * `exhausted` at 17:00Z, and it answered `402 needs a top-up` until 03:03Z, three hours past its own
 * 00:00Z reset. The default for {@link withPlanReset}'s `keyCapNearUtilization`; the caller's config
 * overrides it.
 *
 * Never applied to a refusal that does not name the cap: a key at 97 % of its daily cap can also sit
 * on an empty prepaid balance, and its `402 Insufficient credits` is that balance.
 */
export const DEFAULT_KEY_CAP_NEAR_UTILIZATION = 0.9

/**
 * `failure`, its reset taken from a spent plan window when it stated none of its own.
 *
 * **A refusal about a key cap that resets is a clock**, and which refusals are about the cap is
 * decided by what the refusal itself says, never by the reading alone:
 *
 * - The driver flagged the refusal {@link AttemptFailure.keyCap}: the provider's own words name the
 *   key's cap, or name neither the key nor the balance. Where the sentence names a resetting window
 *   (`openrouter:key-limit-window`: `… create a key with a higher daily limit`) it arrives
 *   `rate-limited` on the driver's **estimated** re-test, because it never names the instant; where
 *   it names no window (`Key limit exceeded`, `limit_source: openrouter_key_limit`) it arrives
 *   `credits-exhausted`. Either way the key's fresh `spend_limit` reading at or past
 *   `keyCapNearUtilization` supplies the reset, when it has one. A `total` cap has none and stays a
 *   human's. A reset the refusal states itself always stands.
 * - A `credits-exhausted` refusal with no such flag names no cap. It borrows only from a cap the
 *   reading says is **fully spent** (prod: `openrouter-glm53-fallback`, `exhausted` from
 *   2026-10-08): refusal and reading then agree. A near-spent cap proves nothing about it. The same
 *   key can sit on an empty prepaid balance (`402 Insufficient credits`), and cooling that until
 *   midnight would answer `429` for a wall only a top-up clears.
 * - A `rate-limited` refusal that states nothing borrows only from a fully spent window, as before:
 *   a per-minute `429` on a key at 95 % of its daily cap is not that cap.
 *
 * Only `spend_limit` lends to a credits refusal. A spent *plan* window says nothing about a balance,
 * and a cap with headroom left, no reset (a `total` cap), or a stale reading leaves the refusal what
 * it was: `exhausted`, a human's.
 */
export function withPlanReset(
  failure: AttemptFailure,
  windows: readonly QuotaWindowState[],
  now: Date,
  maxAgeMs: number,
  keyCapNearUtilization: number = DEFAULT_KEY_CAP_NEAR_UTILIZATION,
): AttemptFailure {
  if (failure.kind === "credits-exhausted") {
    const capReset = keyCapResetFor(failure, windows, now, maxAgeMs, keyCapNearUtilization)
    if (capReset === null) return failure
    if (reportedReset(failure, now) !== null && failure.resetSource !== "estimated")
      return { ...failure, kind: "rate-limited" }
    const { retryAfterSeconds: _dropped, ...rest } = failure
    return { ...rest, kind: "rate-limited", resetsAt: capReset, resetSource: "provider-reported" }
  }
  if (failure.kind !== "rate-limited") return failure
  const stated = reportedReset(failure, now) !== null && failure.resetSource !== "estimated"
  if (stated) return failure
  const planReset =
    spentPlanReset(windows, now, maxAgeMs) ??
    keyCapResetFor(failure, windows, now, maxAgeMs, keyCapNearUtilization)
  if (planReset === null) return failure
  const { retryAfterSeconds: _dropped, ...rest } = failure
  return { ...rest, resetsAt: planReset, resetSource: "provider-reported" }
}

/**
 * The fresh, provider-reported reset of a `spend_limit` key cap at or past `nearUtilization`, or
 * `null`.
 *
 * `nearUtilization` defaults to **fully spent**, which is what a `credits-exhausted` refusal may
 * borrow from, on the breaker's path ({@link withPlanReset}) and on the client error path alike
 * (`dataplane/health.ts`, `keyCapResetAt`): the two read one rule, so a client is never told `429`
 * for an account the breaker parked `exhausted`, nor `402` for one it is cooling. Only a refusal the
 * driver read as the resetting cap passes a lower bound.
 *
 * A cap with headroom, a stale or estimated reading, no reset, or a reset already past lends nothing
 * and invents no instant. Pure, with the clock, freshness bound and utilization bound injected.
 */
export function verifiedKeyCapReset(
  windows: readonly QuotaWindowState[],
  now: Date,
  maxAgeMs: number,
  nearUtilization = 1,
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

/** What {@link keyCapResetFor} reads of a refusal. */
export type KeyCapRefusal = Pick<AttemptFailure, "kind" | "keyCap">

/**
 * The key-cap reset **this refusal** may borrow, or `null`: one predicate for the breaker
 * ({@link withPlanReset}) and for the client's error (`dataplane/chain-failed-attempt.ts`), so the
 * status a client reads and the state the account lands in cannot disagree.
 *
 * The bound follows the refusal's own evidence. One the driver flagged
 * {@link AttemptFailure.keyCap} borrows from a cap at or past `keyCapNearUtilization`. A
 * `credits-exhausted` refusal with no flag borrows only from a fully spent one. Anything else
 * borrows nothing here.
 */
export function keyCapResetFor(
  failure: KeyCapRefusal,
  windows: readonly QuotaWindowState[],
  now: Date,
  maxAgeMs: number,
  keyCapNearUtilization: number = DEFAULT_KEY_CAP_NEAR_UTILIZATION,
): Date | null {
  if (failure.keyCap === true)
    return verifiedKeyCapReset(windows, now, maxAgeMs, keyCapNearUtilization)
  if (failure.kind === "credits-exhausted") return verifiedKeyCapReset(windows, now, maxAgeMs)
  return null
}
