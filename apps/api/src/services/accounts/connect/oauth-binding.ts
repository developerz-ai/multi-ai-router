import type { AccountRepository, AccountRow, OauthStateRow } from "@multi-ai-router/db"
import { httpDriver, type ProviderOAuthFlow } from "../../../providers"
import { type AdminResult, invalid, notFound, ok } from "../../admin/result"

/**
 * The checks every OAuth capture mode makes on an attempt it is about to spend — paste, redirect
 * and device code alike — in one place, so no mode can be the one that skips a check.
 */

/** One sentence for every way a `state` can fail. A refusal that explains itself is an oracle. */
export const STATE_REJECTED = "that authorization is no longer valid — start the connect flow again"

export interface Connectable {
  readonly row: AccountRow
  readonly flow: ProviderOAuthFlow
}

export interface BoundAttempt extends Connectable {
  readonly pending: OauthStateRow
  /** Narrowed from the nullable column: an account-bound attempt always carries one. */
  readonly lifecycleVersion: number
}

export async function connectableAccount(
  accounts: Pick<AccountRepository, "findById">,
  accountId: string,
): Promise<AdminResult<Connectable>> {
  const row = await accounts.findById(accountId)
  if (row === undefined) return notFound(`no account with id "${accountId}"`)
  const flow = httpDriver(row.provider)?.oauth
  if (flow === undefined) {
    return invalid(
      `account "${row.label}" is a ${row.provider} account: it is not connected through an authorization flow this router drives`,
      "not_an_oauth_account",
    )
  }
  return ok({ row, flow })
}

/**
 * An attempt that was just **consumed**, checked against the row it was bound to: still that
 * account's current attempt, same provider, same lifecycle. A superseded or re-pointed attempt
 * fails here, and `commitAuthorization` fences the write a second time on the same two values.
 */
export async function bindConsumed(
  accounts: Pick<AccountRepository, "findById">,
  pending: OauthStateRow | undefined,
  boundTo: string | null,
): Promise<AdminResult<BoundAttempt>> {
  if (pending === undefined || pending.accountId === null) {
    return invalid(STATE_REJECTED, "state_rejected")
  }
  const lifecycleVersion = pending.authorizationLifecycleVersion
  if (lifecycleVersion === null || (boundTo !== null && boundTo !== pending.accountId)) {
    return invalid(STATE_REJECTED, "state_rejected")
  }
  const account = await connectableAccount(accounts, pending.accountId)
  if (!account.ok) return account
  const { row } = account.value
  if (
    row.provider !== pending.provider ||
    row.authorizationAttemptId !== pending.id ||
    row.lifecycleVersion !== lifecycleVersion
  ) {
    return invalid(STATE_REJECTED, "state_rejected")
  }
  return ok({ ...account.value, pending, lifecycleVersion })
}
