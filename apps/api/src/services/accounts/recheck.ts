import type { AccountRepository } from "@multi-ai-router/db"
import { type AdminResult, notFound, ok } from "../admin/result"
import type { HealthStore } from "../dataplane"

/**
 * The operator's **Re-check now**.
 *
 * Providers reset early. Anthropic in particular has reset quotas for everyone ahead of the
 * published schedule, and an operator staring at a countdown they know is wrong needs a way to
 * say so. This is that way.
 *
 * **It is not a separate probe, and that is the design.** Re-checking clears the account's
 * breaker marks, which is exactly the state a cooldown expiring produces: the account becomes
 * eligible again as a *half-open probe*, ranked behind healthy accounts, and the next real
 * request tests it. There is one recovery path in the system and this button joins it rather
 * than adding a second — a dedicated synthetic probe would be a second code path that could
 * disagree with the first, plus an unbilled request to a provider on a button press.
 *
 * Consequently a re-check never reports "it worked" or "it is still down". It reports that the
 * account is eligible again. The honest answer to "is it back" arrives with the next request,
 * and pretending otherwise would mean fabricating a result from a probe we deliberately do not
 * send.
 *
 * **The cooldown is server-side.** A client-side one is a suggestion — a held-down button, an
 * impatient script, or two operators in two browsers all bypass it. This is also why the
 * cooldown applies to `recheckAll` per account rather than globally: rechecking one account then
 * all accounts must not be a way to double the rate.
 */

export interface RecheckResult {
  readonly accountId: string
  /** When this account was last re-checked. Always rendered, so the button is never a mystery. */
  readonly lastCheckedAt: string
  /** When the next re-check is permitted. Equal to `lastCheckedAt` + the configured cooldown. */
  readonly nextAllowedAt: string
  /**
   * False when the cooldown refused this call. Not an error: the operator asked for a state the
   * system is already in, and a 429 for pressing a button twice is hostile.
   */
  readonly rechecked: boolean
}

export interface RecheckService {
  recheck(accountId: string): Promise<AdminResult<RecheckResult>>
  /** Every account, each under its own cooldown. */
  recheckAll(): Promise<AdminResult<readonly RecheckResult[]>>
}

export interface RecheckServiceDeps {
  readonly accounts: Pick<AccountRepository, "list" | "findById">
  readonly health: Pick<HealthStore, "reset">
  readonly cooldownSeconds: number
  readonly now: () => Date
}

export function createRecheckService(deps: RecheckServiceDeps): RecheckService {
  // In memory on purpose: this is the rate limit on a button, not a fact about the account. A
  // restart clears it, which is correct — a restart also clears every breaker mark it guards.
  const lastChecked = new Map<string, Date>()
  const cooldownMs = deps.cooldownSeconds * 1_000

  const attempt = (accountId: string, now: Date): RecheckResult => {
    const previous = lastChecked.get(accountId)
    const withinCooldown = previous !== undefined && now.getTime() - previous.getTime() < cooldownMs

    if (withinCooldown) {
      return {
        accountId,
        lastCheckedAt: previous.toISOString(),
        nextAllowedAt: new Date(previous.getTime() + cooldownMs).toISOString(),
        rechecked: false,
      }
    }

    deps.health.reset(accountId)
    lastChecked.set(accountId, now)
    return {
      accountId,
      lastCheckedAt: now.toISOString(),
      nextAllowedAt: new Date(now.getTime() + cooldownMs).toISOString(),
      rechecked: true,
    }
  }

  return {
    recheck: async (accountId) => {
      const account = await deps.accounts.findById(accountId)
      if (account === undefined) return notFound("No account has that id")
      return ok(attempt(accountId, deps.now()))
    },

    recheckAll: async () => {
      const now = deps.now()
      const accounts = await deps.accounts.list({})
      return ok(accounts.map((account) => attempt(account.id, now)))
    },
  }
}
