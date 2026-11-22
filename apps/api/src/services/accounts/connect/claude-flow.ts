import type { PendingClaudeLoginToken } from "@multi-ai-router/db"
import { type ClaudeLoginHandle, parsePastedCode } from "../../../providers/claude-sdk/login"
import { AUDIT_KINDS, AUDIT_SUBJECTS } from "../../admin/audit"
import { type AdminResult, conflict, invalid, ok } from "../../admin/result"
import { timingSafeEqualStrings } from "../../admin-auth"
import {
  createClaimStore,
  createLeaseFence,
  PASTE_ON_OWNER,
  refuseForeignPaste,
} from "./claude-claims"
import { createClaudeLoginLifetime } from "./claude-lifetime"
import { createPendingLogins, type PendingLogin } from "./claude-pending"
import { findSubscriptionAccount, loginFailure, type SubscriptionAccount } from "./claude-subject"
import type {
  ClaudeConnectCompleted,
  ClaudeConnectDeps,
  ClaudeConnectMode,
  ClaudeConnectService,
} from "./claude-types"
import { createAccountTurns } from "./turns"

const AUTHORIZATION_SUPERSEDED = "the account changed during the login — start again"

export function createClaudeLoginFlow(deps: ClaudeConnectDeps): ClaudeConnectService {
  const pending = createPendingLogins()
  const pendingClaims = new Map<string, PendingClaudeLoginToken>()
  const held = new Map<string, PendingLogin>()
  const turns = createAccountTurns()
  const ttlMs = deps.pendingLoginMinutes * 60_000
  const log = deps.logger?.child({ component: "claude-connect" })

  const { localOwner, ownerOf, token } = createLeaseFence(deps)
  const claims = createClaimStore(deps)
  const clearClaim = (accountId: string, claim: PendingClaudeLoginToken): void => {
    void claims.clear(claim).catch((error: unknown) => {
      log?.warn("claude login claim could not be cleared", { accountId, error: String(error) })
    })
  }
  const releaseClaim = (accountId: string): void => {
    const claim = pendingClaims.get(accountId)
    if (claim === undefined) return
    pendingClaims.delete(accountId)
    clearClaim(accountId, claim)
  }
  const hold = (accountId: string, login: PendingLogin): void => {
    held.set(accountId, login)
    pending.hold(accountId, login, ttlMs, () => {
      if (held.get(accountId) !== login) return
      held.delete(accountId)
      releaseClaim(accountId)
    })
  }
  const release = (accountId: string): PendingLogin | undefined => {
    held.delete(accountId)
    return pending.release(accountId)
  }
  const discard = (accountId: string): void => {
    held.delete(accountId)
    pending.discard(accountId)
  }
  const peek = (accountId: string): PendingLogin | undefined => held.get(accountId)

  const foreignOwner = (accountId: string, message: string): AdminResult<never> => {
    log?.info("claude login refused for a foreign replica", { accountId, owner: ownerOf() })
    return conflict(message, "login_owned_by_another_replica")
  }
  const lifetime = createClaudeLoginLifetime(deps.shutdownDrainMs ?? 15_000, (owners) =>
    log?.warn("claude login shutdown acknowledgement uncertain", { owners }),
  )

  const { find: findClaim, claim: claimNow } = claims
  const subscription = (accountId: string): Promise<AdminResult<SubscriptionAccount>> =>
    findSubscriptionAccount(deps.accounts, accountId)

  const begin = async (accountId: string, mode: ClaudeConnectMode, signal: AbortSignal) => {
    if (lifetime.isClosed(accountId))
      return conflict("account login admission is closed", "account_unavailable")
    const claimToken = token(accountId)
    if (claimToken === undefined)
      return foreignOwner(
        accountId,
        "this instance does not own the account lease — start the login on the owning instance",
      )
    const account = await subscription(accountId)
    if (!account.ok) return account
    // A foreign replica must not touch the account's CLI directory, even to provision it.
    if (ownerOf() !== claimToken.owner) return foreignOwner(accountId, PASTE_ON_OWNER)

    if (account.value.configDir !== deps.configDirs.pathFor(accountId))
      return invalid(
        "account config directory does not match this router root",
        "config_dir_mismatch",
      )

    release(accountId)?.handle.cancel()
    releaseClaim(accountId)

    // The durable claim fences a paste landing on another replica. Write it before any CLI
    // subprocess exists so a refused claim never starts one; it holds no code or credential.
    const expiresAtMs = deps.now().getTime() + ttlMs
    if (!(await claimNow({ ...claimToken }, new Date(expiresAtMs))))
      return foreignOwner(accountId, PASTE_ON_OWNER)

    const configDir = await deps.configDirs.provision(accountId)

    let handle: ClaudeLoginHandle
    try {
      handle = await deps.login.start({ configDir, accountId, signal })
    } catch (error) {
      clearClaim(accountId, claimToken)
      return loginFailure(error, accountId, log)
    }

    lifetime.observe(accountId, handle)
    if (pending.stopping || signal.aborted || lifetime.isClosed(accountId)) {
      handle.cancel()
      clearClaim(accountId, claimToken)
      return conflict("router is shutting down", "shutting_down")
    }

    pendingClaims.set(accountId, claimToken)
    hold(accountId, {
      handle,
      configDir,
      mode,
      subject: account.value,
      expiresAt: new Date(expiresAtMs),
    })
    log?.info("claude login started", { accountId, configDir, mode })

    return ok({
      accountId,
      mode,
      authorizeUrl: handle.authorizeUrl,
      expiresAt: new Date(expiresAtMs).toISOString(),
      capture: "paste" as const,
    })
  }

  const complete = async (
    accountId: string,
    pasted: string,
  ): Promise<AdminResult<ClaudeConnectCompleted>> => {
    const record = peek(accountId)
    if (record === undefined) {
      const claim = await findClaim(accountId)
      if (claim !== undefined && deps.claims !== undefined)
        return foreignOwner(
          accountId,
          "another instance owns this login — paste on the owning instance or start a new login",
        )
      return invalid("no pending login — start a connect first", "no_pending_login")
    }
    if (record.expiresAt.getTime() <= deps.now().getTime()) {
      record.handle.cancel()
      discard(accountId)
      releaseClaim(accountId)
      return invalid("the login window has elapsed — start a new connect", "login_expired")
    }
    // A stale token must not clear a claim just written by the owning replica's new login.
    const foreign = await refuseForeignPaste(deps, accountId, claims, ownerOf, token, foreignOwner)
    if (foreign !== undefined) return foreign
    const parsed = parsePastedCode(pasted)
    if (parsed === null) return invalid("paste must be code#state from the CLI", "malformed_paste")
    if (!timingSafeEqualStrings(record.handle.state, parsed.state)) {
      // The state is one-shot: a wrong paste burns this login rather than leaving it retryable.
      record.handle.cancel()
      releaseClaim(accountId)
      discard(accountId)
      return invalid("the pasted state does not match this login", "state_mismatch")
    }

    // The CLI owns the code. No code or state is written to Postgres, an audit row, or a log.
    // No other account's credentials directory is touched from this point on.
    try {
      await record.handle.submit(`${parsed.code}#${parsed.state}`)
    } catch (error) {
      return loginFailure(error, accountId, log)
    }

    const state = await deps.credentials.settle(accountId)
    // stop() may outlive its drain deadline while a metadata read is still in flight. A late
    // settle must not authorize the account write or the audit event for a closed service.
    if (!lifetime.canCommit(accountId))
      return invalid(AUTHORIZATION_SUPERSEDED, "authorization_superseded")
    const settled: { ok: boolean; repaired?: boolean; code?: string; message?: string } =
      typeof state === "string"
        ? state === "absent" || state === "unreadable"
          ? { ok: false, code: "no_credential", message: state }
          : { ok: true, repaired: state === "repaired" }
        : state
    if (!settled.ok) {
      log?.info("claude login credential settle failed", { accountId, code: settled.code })
      return invalid(settled.message ?? "no credential", settled.code ?? "no_credential")
    }
    const account = await subscription(accountId)
    if (!account.ok) {
      if (account.failure.code === "not_found")
        return invalid(
          "the account changed during the login — start again",
          "authorization_superseded",
        )
      return account
    }
    const loginStartedStatus = record.subject.status
    // The login began against this observation. A later operator write bumps the lifecycle
    // version (or the auth material), so the completion must not cross it.
    if (
      account.value.lifecycleVersion !== record.subject.lifecycleVersion ||
      account.value.authMaterial !== record.subject.authMaterial
    )
      return invalid(AUTHORIZATION_SUPERSEDED, "authorization_superseded")
    const confirmed = await deps.accounts.confirmAccountAuthorization({
      id: accountId,
      expected: account.value,
      now: deps.now(),
    })
    if (confirmed === undefined)
      return invalid("the account changed during the login — start again", "account_changed")
    deps.health?.reset(accountId)
    const repaired = settled.repaired
    // The completed login is consumed only now: a failed submit or missing credential keeps
    // the pending login so the operator can retry with the same state.
    releaseClaim(accountId)
    release(accountId)
    log?.info("claude login completed", {
      accountId,
      mode: record.mode,
      loginStartedStatus,
      status: confirmed.status,
      repaired,
    })
    await deps.refreshCatalog?.()
    deps.onConnected?.(accountId)
    // A first login is onboarding, a reconnect is a repair; the audit log separates them.
    // The pasted code and state never enter a row.
    await deps.audit.record({
      kind:
        record.mode === "reconnect"
          ? AUDIT_KINDS.accountReauthorized
          : AUDIT_KINDS.accountConnected,
      subjectType: AUDIT_SUBJECTS.account,
      subjectId: accountId,
      detail: {
        label: account.value.label,
        provider: account.value.provider,
        loginStartedStatus,
        status: confirmed.status,
      },
    })
    return ok({ accountId, mode: record.mode, connected: true, repaired: repaired === true })
  }
  const cancel = async (accountId: string) => {
    const account = await subscription(accountId)
    if (!account.ok) return account
    if (localOwner() === token(accountId)?.owner) releaseClaim(accountId)
    const found = release(accountId)
    found?.handle.cancel()
    if (found !== undefined) log?.info("claude login cancelled", { accountId })
    return ok({ accountId, cancelled: found !== undefined })
  }

  const clearAllClaims = (): void => {
    for (const [accountId, claim] of pendingClaims) clearClaim(accountId, claim)
    pendingClaims.clear()
  }
  const stopPending = (): void => {
    clearAllClaims()
    pending.stop()
    held.clear()
  }

  return {
    begin: (accountId, mode) =>
      turns.take(accountId, () =>
        lifetime.run(accountId, (signal) => begin(accountId, mode, signal)),
      ),
    complete: (accountId, pasted) =>
      turns.take(accountId, () => lifetime.run(accountId, () => complete(accountId, pasted))),
    cancel: (accountId) => turns.take(accountId, () => cancel(accountId)),
    closeAdmission: () => {
      stopPending()
      lifetime.closeAdmission()
    },
    revoke: (accountId) => {
      releaseClaim(accountId)
      discard(accountId)
      lifetime.revoke(accountId)
    },
    stop: () => {
      stopPending()
      return lifetime.stop()
    },
  }
}
