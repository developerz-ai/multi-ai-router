import { describeError } from "@multi-ai-router/core"
import type { AccountRepository, AccountSummaryRow } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import { CredentialMetadataOwnershipUnavailable } from "../../providers/claude-sdk/ownership-errors"
import type { AccountAuthProbe } from "../../services/health/claudeAuthProbe"

/**
 * What a guardian that could never be launched says about an Account, or null when it says
 * nothing lasting. A missing directory or helper is read off the filesystem and stays true until
 * someone acts, so routing to the Account can only fail; an undiagnosed spawn failure (a spent
 * process table) clears by itself, and parking on it would take a healthy Account out of rotation.
 */
function unownableReason(error: unknown): string | null {
  if (!(error instanceof CredentialMetadataOwnershipUnavailable)) return null
  const failure = error.launchFailure
  if (failure?.reason === "directory_missing")
    return `credential directory is missing (${failure.path}) — log this account in again`
  if (failure?.reason === "helper_unavailable")
    return `credential-owner helper is missing or not executable (${failure.path})`
  return null
}

export interface UnownableParkDeps {
  readonly accounts: Pick<AccountRepository, "findById">
  /** Absent where no CLI is wired: the failure is still logged with its Account. */
  readonly authProbe?: Pick<AccountAuthProbe, "park">
}

/** What a task does with a metadata read that failed, after logging it. Must not throw. */
export type UnreadableMetadataHandler = (
  account: AccountSummaryRow,
  error: unknown,
  logger: Logger,
) => Promise<void>

/**
 * The one verdict a failed metadata read may drive, shared by both tasks: an Account whose owner
 * cannot be launched is parked `needs_reauth` so routing skips it, and the tick moves on to the
 * next Account (#447). A park that cannot be written is logged, never thrown.
 */
export function createUnownablePark(deps: UnownableParkDeps): UnreadableMetadataHandler {
  return async (account, error, logger) => {
    const reason = unownableReason(error)
    if (reason === null) return
    const fields = { accountId: account.id, provider: account.provider, reason }
    try {
      const row = await deps.accounts.findById(account.id)
      const parked = row === undefined ? null : ((await deps.authProbe?.park(row, reason)) ?? null)
      logger.error("credential owner cannot be launched for this account", {
        ...fields,
        statusChangedTo: parked,
      })
    } catch (parkError) {
      logger.error("credential owner cannot be launched and the account was not parked", {
        ...fields,
        error: describeError(parkError, 200),
      })
    }
  }
}
