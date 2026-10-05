import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { Env } from "../../config/env"
import { CLI_REFRESH_LEAD_MS } from "../../providers/claude-sdk/credential-freshness"
import type { CredentialMetadata } from "../../providers/claude-sdk/credential-metadata"
import type { LastLoginLookup } from "../../services/accounts/last-login"
import { loginLifetimePolicy } from "../../services/accounts/login-lifetime"
import type { ScheduledTask } from "../types"
import { createCredentialKeepaliveTask } from "./credential-keepalive"
import type { IdleAccountProbeDeps } from "./idle-account-probe"
import { createLoginLifetimeWatchTask } from "./login-lifetime-watch"

/**
 * The two tasks about a Claude subscription's credential clocks, built from one set of seams so
 * the registry stays a list. Both read only metadata (timestamps) through the same reader the
 * freshness gate uses; neither is built where that reader is not wired.
 */
export interface CredentialTaskDeps {
  readonly accounts: Pick<AccountRepository, "list" | "readEligibleBackgroundAccount">
  /** Credential metadata for one account's config directory. Never a token. */
  readonly credentialMetadata?: (account: AccountRow) => Promise<CredentialMetadata>
  /** Last interactive login per account, from the audit log. */
  readonly lastLogins?: LastLoginLookup
  readonly testAccount?: IdleAccountProbeDeps["test"]
  readonly probeModels?: Readonly<Record<string, string>>
  readonly env: Pick<Env, "claudeLogin" | "claudeSdkCredentialKeepalive" | "scheduler">
}

export function createCredentialTasks(
  deps: CredentialTaskDeps,
  intervals: { readonly credential_keepalive: number; readonly login_lifetime_watch: number },
): readonly ScheduledTask[] {
  const { env, credentialMetadata } = deps
  if (credentialMetadata === undefined) return []
  const tasks: ScheduledTask[] = []

  // Off with `CLAUDE_SDK_CREDENTIAL_KEEPALIVE=false`, like the sweep's own warming: that flag is
  // the operator's "never spend a turn to keep a credential warm".
  if (env.claudeSdkCredentialKeepalive && deps.testAccount !== undefined) {
    tasks.push(
      createCredentialKeepaliveTask({
        accounts: deps.accounts,
        readMetadata: credentialMetadata,
        test: deps.testAccount,
        models: deps.probeModels ?? {},
        policy: {
          leadMs: CLI_REFRESH_LEAD_MS,
          retryMs: env.claudeLogin.keepaliveRetryMinutes * 60_000,
          batchSize: env.scheduler.idleAccountProbeBatchSize,
        },
        intervalMs: intervals.credential_keepalive,
      }),
    )
  }

  if (deps.lastLogins !== undefined) {
    tasks.push(
      createLoginLifetimeWatchTask({
        accounts: deps.accounts,
        readMetadata: credentialMetadata,
        lastLogins: deps.lastLogins,
        policy: loginLifetimePolicy(env.claudeLogin),
        intervalMs: intervals.login_lifetime_watch,
      }),
    )
  }
  return tasks
}
