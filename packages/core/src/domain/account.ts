import { z } from "zod"

/**
 * Account lifecycle states. `cooling_down` and `exhausted` are never conflated: a clock fixes
 * the first, only a human fixes the second. Only `active` accounts survive candidate filtering.
 */
export const AccountStatus = z.enum([
  "active",
  "disabled",
  "cooling_down",
  "exhausted",
  "needs_reauth",
])
export type AccountStatus = z.infer<typeof AccountStatus>

/**
 * Whether an Account's status is a *standing* block or a passing one.
 *
 * `cooling_down` is the only status a clock alone recovers from, so it is the
 * only one that is not standing. Everything else needs something to change:
 * `disabled` needs the operator, `exhausted` needs a top-up, `needs_reauth`
 * needs a re-login.
 *
 * This is the distinction a **listing** wants, and it is not the one candidate
 * filtering wants. Filtering asks "can this account serve *this request, now*",
 * so it drops a cooling account too. A model catalog asks "is this model part of
 * what this key can reach", and a five-minute cooldown must not make a model
 * blink out of the client's list and back — see `dataplane/models.ts`.
 */
export function isStandingBlock(status: AccountStatus): boolean {
  return status === "disabled" || status === "exhausted" || status === "needs_reauth"
}

/**
 * How an Account is *billed* — which decides how its usage is priced, and nothing else.
 *
 * An **account** property rather than a provider one, because the same provider sells both. z.ai,
 * Kimi and MiniMax all sell a flat-fee coding plan alongside their pay-per-token API, under the
 * same endpoint and the same key shape; the router cannot tell them apart from the wire, and the
 * operator knows which one they bought. Deriving this from the provider id — the way a hardcoded
 * two-element set of "subscription providers" once did — priced a coding-plan account as `unknown`
 * and a pay-per-token one identically, which is the same answer to two different questions.
 *
 * - `metered` — a per-token bill. Priced usage is real spend, reported as `metered`.
 * - `subscription` — a flat fee for the period. There is no per-request charge at all, so priced
 *   usage is an *attribution* ("what these tokens would have cost on the API"), reported as
 *   `notional` and never summed with metered spend.
 *
 * The default comes from the provider's driver: a provider sold *only* as a subscription
 * (`anthropic-oauth`, `openai-oauth`) is always `subscription` and the operator cannot say
 * otherwise, because there is no per-token price to meter. Every other provider defaults to
 * `metered` and the operator may mark an account as a plan they bought.
 *
 * docs/idea/08-observability.md#cost-estimation.
 */
export const AccountBilling = z.enum(["metered", "subscription"])
export type AccountBilling = z.infer<typeof AccountBilling>

/** What an Account is unless its provider forces otherwise, and what a migration backfills. */
export const DEFAULT_ACCOUNT_BILLING: AccountBilling = "metered"

/**
 * The quota windows an Account can hold. A Claude subscription has several running concurrently
 * and resetting independently, and the account is blocked by whichever one is spent.
 *
 * `overage` is the paid allowance *beyond* the included windows, and it is a window rather than a
 * flag because it resets on its own clock and the operator has to be able to see when. It never
 * blocks an account by itself: a spent overage matters only once an included window is spent too,
 * so the reading that filters an account out always comes from one of the four above it.
 */
export const QuotaWindowKind = z.enum([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "overage",
])
export type QuotaWindowKind = z.infer<typeof QuotaWindowKind>

/**
 * How long each window spans, so "tokens used *in this window*" has a start instant.
 *
 * A window's start is `resetsAt - span`, which is the only way to bound the usage query correctly:
 * "the last five hours from now" is a different range from "the five hours this window covers", and
 * they diverge by exactly however long ago the window opened.
 *
 * `overage` has no span — it is a paid allowance beside the included windows, not a rolling clock —
 * so it is absent rather than guessed, and a bar is simply not drawn for it.
 */
export const QUOTA_WINDOW_SPAN_MS: Readonly<Partial<Record<QuotaWindowKind, number>>> = {
  five_hour: 5 * 60 * 60 * 1_000,
  seven_day: 7 * 24 * 60 * 60 * 1_000,
  seven_day_opus: 7 * 24 * 60 * 60 * 1_000,
  seven_day_sonnet: 7 * 24 * 60 * 60 * 1_000,
}

/**
 * Operator-set token ceilings per quota window — **an estimate the operator owns, never a fact the
 * provider stated.**
 *
 * This exists because Anthropic publishes no numeric limit and its SDK reports a `utilization`
 * only when a window is already near its edge, so for most of every window the console has nothing
 * to draw. A ceiling written here lets the router show consumption it measured itself against a
 * number the operator chose.
 *
 * Two honesty rules follow from that and are enforced at the render, not here: the bar is labelled
 * as configured, and it never feeds routing. Nothing in `services/routing/` reads this — a guess
 * about someone else's accounting must not decide which account serves a request.
 */
export const WindowTokenLimits = z.record(QuotaWindowKind, z.number().int().positive())
export type WindowTokenLimits = z.infer<typeof WindowTokenLimits>

/**
 * Where a utilization reading comes from — a first-class distinction, not a provider detail.
 *
 * - `continuous` — a real percentage at any point in the window. The only kind `quota-aware` can
 *   rank on.
 * - `threshold-triggered` — an alarm that fires only near the limit. Reads `null` for most of a
 *   window; good for tripping the breaker, useless for ranking.
 * - `none` — no signal at all.
 *
 * Always carried, because an empty gauge from a threshold-triggered source is correct and reads
 * as broken.
 */
export const UtilizationSource = z.enum(["continuous", "threshold-triggered", "none"])
export type UtilizationSource = z.infer<typeof UtilizationSource>

/**
 * How trustworthy a reset timestamp is. Always displayed next to the countdown — a guessed
 * reset shown as fact is worse than no reset at all.
 */
export const ResetSource = z.enum(["provider-reported", "estimated", "unknown"])
export type ResetSource = z.infer<typeof ResetSource>

/**
 * One window's quota state. `utilization` is optional on purpose: a threshold-triggered source
 * reports nothing until consumption nears the limit, so an absent reading is a normal state for
 * most of a window, not a fault — which is exactly why `utilizationSource` travels with it.
 *
 * An `exhausted` Account has no reset by definition, so `resetsAt` is absent there and the UI
 * shows "needs top-up" rather than a countdown.
 */
export const QuotaWindowState = z.object({
  window: QuotaWindowKind,
  utilization: z.number().min(0).max(1).optional(),
  utilizationSource: UtilizationSource,
  resetsAt: z.date().optional(),
  resetSource: ResetSource,
  lastCheckedAt: z.date(),
})
export type QuotaWindowState = z.infer<typeof QuotaWindowState>
