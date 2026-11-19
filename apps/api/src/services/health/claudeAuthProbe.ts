import type { AccountStatus, ProviderId } from "@multi-ai-router/core"
import type { AccountRepository } from "@multi-ai-router/db"
import type { AccountConfigDirs } from "../../providers/claude-sdk/config-dir"
import type { ClaudeAuthCheck } from "../../providers/claude-sdk/login"
import { describeProvider } from "../accounts/providers"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"

/**
 * Whether one Claude subscription Account is still logged in — and the one status transition that
 * answer is allowed to drive.
 *
 * **Why this Account class gets a probe and no other does.** `../accounts/recheck.ts` explains at
 * length why "Re-check now" sends nothing: a synthetic request to a provider is billed, and a second
 * recovery path could disagree with the real one. Neither objection applies here. `claude auth
 * status` reads a file the CLI wrote in the Account's own directory — no provider is contacted and
 * nothing is spent — and it answers a question the breaker cannot: not "is the window back" but "is
 * this Account logged in at all". So it joins the re-check rather than adding a path beside it, and
 * it is the only probe in the router that can honestly report a result on a button press.
 *
 * It is also the answer to the gap the design left open (docs/idea/11-anthropic-agent-sdk.md §12.7):
 * because the router never refreshes subscription tokens, a revoked credential is otherwise
 * invisible until every request to the Account has already failed.
 *
 * **`needs_reauth` is the only status it writes, in either direction.** A `disabled` Account stays
 * disabled — a probe is not a way around an operator's decision — and an Account that is merely
 * cooling down keeps its cooldown, because being rate limited says nothing about being logged in.
 *
 * Nothing here reads, copies, or logs credential material: it runs a subcommand, and what comes back
 * is a boolean, an email, and a plan name (CLAUDE.md non-negotiable 1).
 */

/** What the probe needs to know about a row. Passed in, because every caller already has it. */
export interface AuthProbeSubject {
  readonly id: string
  readonly provider: ProviderId
  /** The stored status, which is what the transition below is decided against. */
  readonly status: AccountStatus
  readonly lifecycleVersion: number
  readonly authMaterial: string | null
}

export interface ClaudeAuthReport {
  readonly loggedIn: boolean
  readonly email: string | null
  readonly subscriptionType: string | null
  /** The status this probe moved the row to, or null when it left the row exactly as it was. */
  readonly statusChangedTo: AccountStatus | null
  readonly checkedAt: string
}

export interface AccountAuthProbe {
  /**
   * Null when there is nothing to say: the Account carries no CLI-managed credential, or the CLI
   * could not answer. Neither is reported as a logged-out Account.
   */
  check(account: AuthProbeSubject, operatorCheckToken?: string): Promise<ClaudeAuthReport | null>
  /**
   * Parks an Account whose credential directory cannot be owned at all — it is gone, or the
   * owner helper is — so no CLI could be asked and `check` would answer `null` forever. Same
   * fence, same audit kind and same exits as a logged-out answer: a login re-provisions the
   * directory, and the next `check` that finds a login recovers the row. `reason` is the audit
   * row's. Returns the status written, or null when the row was not `active`/`cooling_down`.
   */
  park(account: AuthProbeSubject, reason: string): Promise<AccountStatus | null>
}

export interface ClaudeAuthProbeDeps {
  readonly accounts: Pick<
    AccountRepository,
    "transitionObservedStatus" | "recoverObservedAuthentication"
  >
  readonly configDirs: Pick<AccountConfigDirs, "pathFor">
  readonly cli: ClaudeAuthCheck
  readonly audit: AuditRecorder
  readonly now: () => Date
  readonly mutationCommitted?: (accountId: string) => Promise<void>
}

export function createClaudeAuthProbe(deps: ClaudeAuthProbeDeps): AccountAuthProbe {
  return {
    check: async (account, operatorCheckToken) => {
      // Asked of the provider registry rather than of the stored `configDir`, which is nullable and
      // only as good as the row that was written — see `../accounts/providers.ts`.
      if (!describeProvider(account.provider).requiresConfigDir) return null

      const status = await deps.cli.check(deps.configDirs.pathFor(account.id))
      if (status === null) return null

      const now = deps.now()
      const statusChangedTo = await transition(
        deps,
        account,
        status.loggedIn,
        now,
        operatorCheckToken,
      )
      return { ...status, statusChangedTo, checkedAt: now.toISOString() }
    },
    park: async (account, reason) => {
      if (!describeProvider(account.provider).requiresConfigDir) return null
      return parkNeedsReauth(deps, account, deps.now(), reason, undefined, "credential_owner")
    },
  }
}

/**
 * The two moves a credential check may make, and nothing else.
 *
 * Auditing both, with different kinds: regaining a login is `account.reauthorized`, losing one is an
 * ordinary `account.updated` naming the reason. There is deliberately no `account.deauthorized` — a
 * kind invented for one writer is a kind the console has to learn about to filter on, and the row
 * change is exactly what `account.updated` already means.
 */
async function transition(
  deps: ClaudeAuthProbeDeps,
  account: AuthProbeSubject,
  loggedIn: boolean,
  now: Date,
  operatorCheckToken?: string,
): Promise<AccountStatus | null> {
  if (loggedIn && account.status === "needs_reauth") {
    const changed = await deps.accounts.recoverObservedAuthentication({
      id: account.id,
      expected: {
        lifecycleVersion: account.lifecycleVersion,
        authMaterial: account.authMaterial,
        status: "needs_reauth",
        ...(operatorCheckToken === undefined ? {} : { operatorCheckToken }),
      },
      now,
    })
    if (changed === undefined) return null
    await deps.mutationCommitted?.(account.id)
    await record(deps, account, AUDIT_KINDS.accountReauthorized, { previousStatus: "needs_reauth" })
    return "active"
  }

  if (loggedIn) return null
  return parkNeedsReauth(
    deps,
    account,
    now,
    "claude auth status reports this account logged out",
    operatorCheckToken,
  )
}

async function parkNeedsReauth(
  deps: ClaudeAuthProbeDeps,
  account: AuthProbeSubject,
  now: Date,
  reason: string,
  operatorCheckToken?: string,
  source?: string,
): Promise<AccountStatus | null> {
  // `disabled` is the operator's; `needs_reauth` is already where this would put it.
  if (account.status !== "active" && account.status !== "cooling_down") return null
  const changed = await deps.accounts.transitionObservedStatus({
    id: account.id,
    expected: {
      lifecycleVersion: account.lifecycleVersion,
      authMaterial: account.authMaterial,
      status: account.status,
      ...(operatorCheckToken === undefined ? {} : { operatorCheckToken }),
    },
    status: "needs_reauth",
    now,
  })
  if (changed === undefined) return null
  await deps.mutationCommitted?.(account.id)
  await record(deps, account, AUDIT_KINDS.accountUpdated, {
    status: "needs_reauth",
    previousStatus: account.status,
    reason,
    ...(source === undefined ? {} : { source }),
  })
  return "needs_reauth"
}

function record(
  deps: ClaudeAuthProbeDeps,
  account: AuthProbeSubject,
  kind: string,
  detail: Record<string, unknown>,
): Promise<void> {
  // Names and flags only. The email the probe read is not written here: an audit row is about what
  // changed on the row, and the identity behind a subscription is not the router's to log.
  return deps.audit.record({
    kind,
    subjectType: AUDIT_SUBJECTS.account,
    subjectId: account.id,
    detail: { provider: account.provider, source: "claude_auth_status", ...detail },
  })
}
