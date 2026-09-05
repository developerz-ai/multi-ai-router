import type { AccountStatus, ProviderId } from "@multi-ai-router/core"
import type { AccountRepository } from "@multi-ai-router/db"
import type { Logger } from "../../../logging/logger"
import { ClaudeLoginError } from "../../../providers/claude-sdk/login"
import { type AdminResult, invalid, notFound, ok } from "../../admin/result"
import { describeProvider } from "../providers"

/**
 * The two answers `claude.ts` gives before any login runs: which account this is and whether it is
 * a subscription at all, and how a CLI refusal is reported. Split out so the flow file holds the
 * flow and nothing else.
 */

export interface SubscriptionAccount {
  readonly id: string
  readonly label: string
  readonly provider: ProviderId
  readonly status: AccountStatus
}

/**
 * The CLI's failures: a router-authored sentence for the operator, the diagnostic tail for the log.
 *
 * The two halves never swap. `message` is the only thing rendered, and `logDetail` — the CLI's own
 * words, already redacted where they were read — is the only thing logged. Anything that is not a
 * `ClaudeLoginError` is a bug on this side and is rethrown rather than flattened into a 400 the
 * operator cannot act on.
 */
export function loginFailure(error: unknown, accountId: string, log?: Logger): AdminResult<never> {
  if (!(error instanceof ClaudeLoginError)) throw error
  log?.warn("claude cli login failed", {
    accountId,
    kind: error.kind,
    ...(error.logDetail === null ? {} : { cliOutput: error.logDetail }),
  })
  return invalid(error.message, `claude_login_${error.kind}`)
}

/** The account, if it exists and is one the `claude` CLI connects. Every other answer is a refusal. */
export async function findSubscriptionAccount(
  accounts: Pick<AccountRepository, "findById">,
  accountId: string,
): Promise<AdminResult<SubscriptionAccount>> {
  const row = await accounts.findById(accountId)
  if (row === undefined) return notFound(`no account with id "${accountId}"`)
  if (!describeProvider(row.provider).requiresConfigDir) {
    return invalid(
      `account "${row.label}" is a ${row.provider} account: only Claude subscription accounts are connected through the claude CLI`,
      "not_a_subscription_account",
    )
  }
  return ok({ id: row.id, label: row.label, provider: row.provider, status: row.status })
}
