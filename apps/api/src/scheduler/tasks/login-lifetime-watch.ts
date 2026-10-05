import { describeError } from "@multi-ai-router/core"
import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { CredentialMetadata } from "../../providers/claude-sdk/credential-metadata"
import type { LastLoginLookup } from "../../services/accounts/last-login"
import {
  computeLoginLifetime,
  type LoginLifetimePolicy,
} from "../../services/accounts/login-lifetime"
import { describeProvider } from "../../services/accounts/providers"
import type { ScheduledTask, TaskOutcome } from "../types"

/**
 * One structured `warn` line per subscription per day while its **login** is inside the renewal
 * warn window — the alertable twin of the console banner.
 *
 * Idempotent by cadence: the interval is a day (`LOGIN_LIFETIME_WATCH_INTERVAL_MINUTES`) and the
 * scheduler resumes it from the persisted last run, so neither a restart nor a second replica
 * (which loses the advisory lock) logs the line twice. Reads only: credential timestamps through the
 * metadata reader, last interactive logins through one audit query. Never a token, never a write.
 *
 * Accounts already `needs_reauth` or `disabled` are not warned about — the first has its own louder
 * signals (parked status, the red console banner), the second is the operator's choice.
 */

export interface LoginLifetimeWatchDeps {
  readonly accounts: Pick<AccountRepository, "list">
  readonly readMetadata: (account: AccountRow) => Promise<CredentialMetadata>
  readonly lastLogins: LastLoginLookup
  readonly policy: LoginLifetimePolicy
  readonly intervalMs: number
}

export function createLoginLifetimeWatchTask(deps: LoginLifetimeWatchDeps): ScheduledTask {
  return {
    name: "login_lifetime_watch",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }): Promise<TaskOutcome> => {
      try {
        const subscriptions = (await deps.accounts.list({})).filter(
          (account) =>
            describeProvider(account.provider).requiresConfigDir &&
            account.status !== "disabled" &&
            account.status !== "needs_reauth",
        )
        const logins = await deps.lastLogins(subscriptions.map((account) => account.id))

        let warned = 0
        let unreadable = 0
        for (const account of subscriptions) {
          if (signal.aborted) return { outcome: "partial", itemsProcessed: warned }
          let metadata: CredentialMetadata
          try {
            metadata = await deps.readMetadata(account)
          } catch (error) {
            unreadable += 1
            logger.warn("login lifetime: credential metadata unreadable", {
              accountId: account.id,
              reason: describeError(error, 200),
            })
            continue
          }
          const lifetime = computeLoginLifetime({
            metadata,
            lastLoginAt: logins.get(account.id) ?? null,
            now,
            policy: deps.policy,
          })
          if (!lifetime.renewalRequiredSoon) continue
          warned += 1
          // The alert line. Field names are the contract an alert rule matches on — see
          // docs/idea/08-observability.md. Timestamps and a label, nothing read from the token.
          logger.warn("claude subscription login renewal due", {
            accountId: account.id,
            label: account.label,
            renewsAt: lifetime.renewsAt?.toISOString() ?? null,
            renewsAtSource: lifetime.source,
            daysUntilRenewal: lifetime.daysUntilRenewal,
            lastLoginAt: lifetime.lastLoginAt?.toISOString() ?? null,
          })
        }
        logger.info("login lifetime watch", {
          outcome: "success",
          subscriptions: subscriptions.length,
          warned,
          unreadable,
        })
        return { outcome: "success", itemsProcessed: warned }
      } catch (error) {
        const reason = describeError(error, Number.POSITIVE_INFINITY)
        logger.error("login lifetime watch failed", { error: reason })
        return { outcome: "failed", itemsProcessed: 0, error: reason }
      }
    },
  }
}
