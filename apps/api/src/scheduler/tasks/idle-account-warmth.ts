import { describeError } from "@multi-ai-router/core"
import type { AccountRow } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import type { IdleAccountProbeDeps } from "./idle-account-probe"

/**
 * The per-account half of `idle_account_probe` that spends, or refuses to spend, a subprocess:
 * whether a credential is cold, the real turn that warms it, the turn-free gauge read that may
 * only follow a warm one, and the tally the sweep reports. Split from the task so the task reads
 * as the sweep's order of operations and this reads as what each step costs.
 */

export interface Tally {
  /** Accounts the free check answered for, either way. */
  checked: number
  /** Accounts the free check found logged out — parked `needs_reauth` by the probe. */
  loggedOut: number
  /** Accounts the free check found logged in again after `needs_reauth`. */
  reauthorized: number
  /** Subscription accounts whose usage gauge was read on this sweep, turn-free. */
  gauged: number
  /** Idle accounts billed a keepalive turn. */
  probed: number
  /** Subscription accounts whose access token was cold and was warmed by a keepalive turn. */
  warmed: number
  /** Subscription accounts found cold while warming is switched off. */
  cold: number
  refreshed: number
  failed: number
  skipped: number
}

/**
 * Whether a `claude` subprocess spawned against this account now would refresh its access token.
 *
 * The signal the 2026-09-06 losses needed and nobody had — and the one whose *meaning* the first
 * two fixes got wrong. A subscription's access token lives ~8 h; the CLI refreshes it only inside
 * its own five-minute lead, and only a process that runs to completion persists the rotated
 * refresh token. So "cold" is not "expires before the next sweep" (a turn that early refreshes
 * nothing) — it is "the next spawn will refresh", which is the moment a turn-free spawn must yield
 * to a real turn.
 *
 * Unknown is **not** cold: an unreadable file or an expiry the file never carried answers `false`,
 * and warming on that would bill a turn against every account forever.
 */
export async function isCold(
  deps: Pick<IdleAccountProbeDeps, "cold">,
  account: AccountRow,
  logger: Logger,
): Promise<boolean> {
  if (deps.cold === undefined) return false
  try {
    return await deps.cold(account)
  } catch (error) {
    // Unreadable is unknown, never cold — the same rule `services/accounts/credential.ts` applies.
    logger.warn("access token freshness unreadable", {
      accountId: account.id,
      reason: describeError(error, 200),
    })
    return false
  }
}

/**
 * The keepalive: one small real turn so a live process refreshes and persists the credential.
 * Resolves `true` only when the turn ran and succeeded — the one case a turn-free read may follow.
 * Bounded per tick by `batchSize`, because every warm is a ~245 MB subprocess and a billed turn.
 */
export async function warm(
  deps: Pick<IdleAccountProbeDeps, "test" | "models" | "warmCredentials" | "batchSize">,
  account: AccountRow,
  logger: Logger,
  tally: Tally,
): Promise<boolean> {
  const model = deps.models[account.provider]
  const reason = !deps.warmCredentials
    ? "keepalive is off"
    : model === undefined
      ? "no probe model for this provider"
      : tally.warmed >= deps.batchSize
        ? "keepalive batch is full for this tick"
        : null
  if (reason !== null || model === undefined) {
    tally.cold += 1
    // `warn`: until a client's turn refreshes it, this account's gauge and catalog stand still.
    logger.warn("subscription access token is cold and was not warmed", {
      accountId: account.id,
      provider: account.provider,
      reason: reason ?? "no probe model for this provider",
    })
    return false
  }
  tally.warmed += 1
  return keepAlive(deps, account, model, logger, tally)
}

/** The gauge read, free: a failure here is a reading not taken, logged and never a run outcome. */
export async function readUsage(
  deps: Pick<IdleAccountProbeDeps, "usage">,
  account: AccountRow,
  logger: Logger,
  tally: Tally,
): Promise<void> {
  if (deps.usage === undefined) return
  try {
    const outcome = await deps.usage(account)
    if (outcome === "read") tally.gauged += 1
    // Warm a moment ago and cold now: the turn's refresh did not land, or the token expired in
    // between. Not an error — the reading waits for the next real turn, and the probe refused to
    // spawn rather than spend the refresh token.
    if (outcome === "cold") {
      logger.info("idle account usage gauge not read: credential is cold", {
        accountId: account.id,
        provider: account.provider,
      })
    }
  } catch (error) {
    logger.warn("idle account usage gauge not read", {
      accountId: account.id,
      provider: account.provider,
      error: describeError(error, Number.POSITIVE_INFINITY),
    })
  }
}

/** The billed turn. Never writes a status: the test already fed the breaker, whose verdict is better. */
export async function keepAlive(
  deps: Pick<IdleAccountProbeDeps, "test">,
  account: AccountRow,
  model: string,
  logger: Logger,
  tally: Tally,
): Promise<boolean> {
  const result = await deps.test(account.id, model)
  if (!result.tested) {
    // Its own cooldown declined — an operator tested it moments ago. Nothing was billed.
    tally.skipped += 1
    return false
  }
  tally.probed += 1
  if (result.outcome === "ok") {
    tally.refreshed += 1
    logger.info("idle account kept alive", { accountId: account.id, provider: account.provider })
    return true
  }
  tally.failed += 1
  logger.warn("idle account failed its keepalive test", {
    accountId: account.id,
    provider: account.provider,
  })
  return false
}
