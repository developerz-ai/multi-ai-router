import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminResult, notFound, ok } from "../admin/result"
import type { HealthStore } from "../dataplane"
import type { AccountAuthProbe, ClaudeAuthReport } from "../health/claudeAuthProbe"

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
 * **The one exception proves the rule.** A Claude subscription can be asked, locally and for free,
 * whether it is still logged in — `claude auth status` reads the credential file the CLI wrote, with
 * no provider contacted and nothing billed. That answer is a *different fact* from "is the window
 * back", and it is the only way a silently revoked credential becomes visible before every request
 * to the account has failed. So it rides on this call rather than getting a button of its own
 * (`../health/claudeAuthProbe.ts`), and its result is reported per account as `auth`.
 *
 * **The cooldown is server-side.** A client-side one is a suggestion — a held-down button, an
 * impatient script, or two operators in two browsers all bypass it. This is also why the
 * cooldown applies to `recheckAll` per account rather than globally: rechecking one account then
 * all accounts must not be a way to double the rate. It is also what bounds the subprocess above:
 * no button press can spawn a second one for an account inside its window.
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
  /**
   * What the account's own credential says, for the account class that can be asked. Absent for
   * every other provider, and absent when the CLI could not answer — which is never the same thing
   * as an account reporting itself logged out.
   */
  readonly auth?: ClaudeAuthReport
}

export interface RecheckService {
  recheck(accountId: string): Promise<AdminResult<RecheckResult>>
  /** Every account, each under its own cooldown. */
  recheckAll(): Promise<AdminResult<readonly RecheckResult[]>>
  /**
   * When this account was last re-checked, or null if not since this process started.
   *
   * Synchronous and in-memory: the accounts list reads it per row, and CLAUDE.md requires the
   * timestamp to be visible whether or not the operator just pressed the button — a control whose
   * last effect is invisible is a mystery box.
   */
  lastCheckedAt(accountId: string): Date | null
}

export interface RecheckServiceDeps {
  readonly accounts: Pick<AccountRepository, "list" | "findById">
  readonly health: Pick<HealthStore, "reset">
  readonly audit: AuditRecorder
  /**
   * Absent means subscription accounts get the breaker reset and nothing more. Optional because a
   * deployment with no Claude subscriptions has nothing for it to ask.
   */
  readonly auth?: AccountAuthProbe
  readonly cooldownSeconds: number
  readonly now: () => Date
}

export function createRecheckService(deps: RecheckServiceDeps): RecheckService {
  // In memory on purpose: this is the rate limit on a button, not a fact about the account. A
  // restart clears it, which is correct — a restart also clears every breaker mark it guards.
  const lastChecked = new Map<string, Date>()
  const cooldownMs = deps.cooldownSeconds * 1_000

  const refused = (accountId: string, previous: Date): RecheckResult => ({
    accountId,
    lastCheckedAt: previous.toISOString(),
    nextAllowedAt: new Date(previous.getTime() + cooldownMs).toISOString(),
    rechecked: false,
  })

  const attempt = async (account: AccountRow, now: Date): Promise<RecheckResult> => {
    const previous = lastChecked.get(account.id)
    if (previous !== undefined && now.getTime() - previous.getTime() < cooldownMs) {
      return refused(account.id, previous)
    }

    deps.health.reset(account.id)
    lastChecked.set(account.id, now)

    // After the reset, never before: the breaker marks are cleared whether or not the CLI answers,
    // so a missing binary can never cost an account the recovery this button exists to give it.
    const auth = (await deps.auth?.check(account)) ?? undefined

    await deps.audit.record({
      kind: AUDIT_KINDS.accountRechecked,
      subjectType: AUDIT_SUBJECTS.account,
      subjectId: account.id,
      detail: {
        provider: account.provider,
        // Flags, never the email or the plan the probe read — those are for the operator's screen,
        // not for an append-only log the janitor keeps for months.
        ...(auth === undefined
          ? {}
          : { loggedIn: auth.loggedIn, statusChangedTo: auth.statusChangedTo }),
      },
    })

    return {
      accountId: account.id,
      lastCheckedAt: now.toISOString(),
      nextAllowedAt: new Date(now.getTime() + cooldownMs).toISOString(),
      rechecked: true,
      ...(auth === undefined ? {} : { auth }),
    }
  }

  return {
    recheck: async (accountId) => {
      const account = await deps.accounts.findById(accountId)
      if (account === undefined) return notFound("No account has that id")
      return ok(await attempt(account, deps.now()))
    },

    lastCheckedAt: (accountId) => lastChecked.get(accountId) ?? null,

    recheckAll: async () => {
      const now = deps.now()
      const accounts = await deps.accounts.list({})
      const results: RecheckResult[] = []
      // Sequential, not `Promise.all`: each account that is actually re-checked may spawn a `claude
      // auth status`, and fanning those out means one button press forking once per subscription.
      for (const account of accounts) results.push(await attempt(account, now))
      return ok(results)
    },
  }
}
