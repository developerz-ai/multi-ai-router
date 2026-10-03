import type { AccountRepository } from "@multi-ai-router/db"
import type { Logger } from "../../../logging/logger"
import type { AccountConfigDirs } from "../../../providers/claude-sdk/config-dir"
import {
  type ClaudeCliLogin,
  type ClaudeLoginHandle,
  type CredentialGuard,
  parsePastedCode,
} from "../../../providers/claude-sdk/login"
import { UpstreamAdmissionRefused } from "../../../providers/upstream-admission"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../../admin/audit"
import { type AdminResult, conflict, invalid, ok } from "../../admin/result"
import { timingSafeEqualStrings } from "../../admin-auth"
import type { HealthStore } from "../../dataplane"
import { createClaudeLoginLifetime } from "./claude-lifetime"
import { createPendingLogins } from "./claude-pending"
import { findSubscriptionAccount, loginFailure, type SubscriptionAccount } from "./claude-subject"
import { createAccountTurns } from "./turns"

export type ClaudeConnectMode = "connect" | "reconnect"

export interface ClaudeConnectStarted {
  readonly accountId: string
  readonly mode: ClaudeConnectMode
  readonly authorizeUrl: string
  readonly expiresAt: string
  readonly capture: "paste"
}

export interface ClaudeConnectCompleted {
  readonly accountId: string
  readonly mode: ClaudeConnectMode
  readonly connected: true
  readonly repaired: boolean
}

export interface ClaudeConnectCancelled {
  readonly accountId: string
  readonly cancelled: boolean
}

export interface ClaudeConnectService {
  begin(accountId: string, mode: ClaudeConnectMode): Promise<AdminResult<ClaudeConnectStarted>>
  complete(accountId: string, pasted: string): Promise<AdminResult<ClaudeConnectCompleted>>
  cancel(accountId: string): Promise<AdminResult<ClaudeConnectCancelled>>
  closeAdmission(): void
  revoke(accountId: string): void
  stop(): Promise<void>
}

export interface ClaudeConnectDeps {
  readonly shutdownDrainMs?: number
  readonly accounts: Pick<AccountRepository, "findById" | "confirmAccountAuthorization">
  readonly configDirs: AccountConfigDirs
  readonly login: ClaudeCliLogin
  readonly credentials: CredentialGuard
  readonly audit: AuditRecorder
  readonly pendingLoginMinutes: number
  readonly logger?: Logger
  readonly now: () => Date
  readonly health?: Pick<HealthStore, "reset">
  readonly refreshCatalog?: () => Promise<void>
  readonly onConnected?: (accountId: string) => void
}

export function createClaudeConnectService(deps: ClaudeConnectDeps): ClaudeConnectService {
  const pending = createPendingLogins()
  const turns = createAccountTurns()
  const ttlMs = deps.pendingLoginMinutes * 60_000
  const log = deps.logger?.child({ component: "claude-connect" })

  const lifetime = createClaudeLoginLifetime(deps.shutdownDrainMs ?? 15_000, (owners) => {
    log?.warn("claude login shutdown acknowledgement uncertain", { owners })
  })

  const rejected = (accountId: string, message: string, code: string): AdminResult<never> => {
    log?.info("claude login rejected", { accountId, code })
    return invalid(message, code)
  }

  const subscription = (accountId: string): Promise<AdminResult<SubscriptionAccount>> =>
    findSubscriptionAccount(deps.accounts, accountId)

  return {
    begin: (accountId, mode) =>
      turns.take(accountId, () =>
        lifetime.run(accountId, async (signal) => {
          if (lifetime.isClosed(accountId))
            return conflict("account login admission is closed", "account_unavailable")
          const account = await subscription(accountId)
          if (!account.ok) return account

          if (account.value.configDir !== deps.configDirs.pathFor(accountId))
            return invalid(
              "account config directory does not match this router root",
              "config_dir_mismatch",
            )

          pending.discard(accountId)

          const configDir = await deps.configDirs.provision(accountId)

          let handle: ClaudeLoginHandle
          try {
            handle = await deps.login.start({ configDir, accountId, signal })
          } catch (error) {
            return loginFailure(error, accountId, log)
          }

          lifetime.observe(accountId, handle)
          if (pending.stopping || signal.aborted || lifetime.isClosed(accountId)) {
            handle.cancel()
            return conflict(
              "this router is shutting down — connect this account once it is back",
              "shutting_down",
            )
          }

          const current = await subscription(accountId)
          if (
            !current.ok ||
            current.value.lifecycleVersion !== account.value.lifecycleVersion ||
            current.value.authMaterial !== account.value.authMaterial ||
            current.value.configDir !== configDir ||
            lifetime.isClosed(accountId) ||
            signal.aborted
          ) {
            handle.cancel()
            return conflict("account changed while login was starting", "account_unavailable")
          }
          const expiresAt = new Date(deps.now().getTime() + ttlMs)
          pending.hold(
            accountId,
            { handle, configDir, mode, expiresAt, subject: account.value },
            ttlMs,
          )
          log?.info("claude login started", { accountId, mode, expiresAt: expiresAt.toISOString() })

          return ok({
            accountId,
            mode,
            authorizeUrl: handle.authorizeUrl,
            expiresAt: expiresAt.toISOString(),
            capture: "paste",
          })
        }),
      ),

    complete: (accountId, pasted) =>
      turns.take(accountId, () =>
        lifetime.run(accountId, async () => {
          const account = await subscription(accountId)
          if (!account.ok) return account

          const found = pending.release(accountId)
          if (found === undefined) {
            return rejected(
              accountId,
              "no login is pending for this account — start one and paste the code within the window",
              "no_pending_login",
            )
          }

          if (deps.now() >= found.expiresAt) {
            found.handle.cancel()
            return rejected(accountId, "that login expired — start a new one", "login_expired")
          }

          const parsed = parsePastedCode(pasted)
          if (parsed === null) {
            found.handle.cancel()
            return rejected(
              accountId,
              "paste the whole value from the authorization page, in the form code#state",
              "malformed_paste",
            )
          }
          if (!timingSafeEqualStrings(parsed.state, found.handle.state)) {
            found.handle.cancel()
            return rejected(
              accountId,
              "that code belongs to a different login — start a new one and paste the value it gives you",
              "state_mismatch",
            )
          }

          try {
            await found.handle.submit(pasted.trim())
          } catch (error) {
            return loginFailure(error, accountId, log)
          }

          let state: Awaited<ReturnType<CredentialGuard["settle"]>>
          try {
            state = await deps.credentials.settle(found.configDir)
          } catch (error) {
            if (!(error instanceof UpstreamAdmissionRefused)) throw error
            return conflict(
              "account changed before credential validation",
              "authorization_superseded",
            )
          }
          if (state === "absent" || state === "unreadable") {
            return rejected(
              accountId,
              "the claude CLI finished without leaving a usable credential — start the login again",
              "no_credential",
            )
          }

          if (!lifetime.canCommit(accountId))
            return conflict(
              "account login completion is no longer admitted",
              "authorization_superseded",
            )
          const loginStartedStatus = found.subject.status
          const committed = await deps.accounts.confirmAccountAuthorization({
            id: accountId,
            expected: {
              lifecycleVersion: found.subject.lifecycleVersion,
              authMaterial: found.subject.authMaterial,
            },
            now: deps.now(),
          })
          if (committed === undefined) {
            return conflict(
              "this account changed while login was pending — start a new login",
              "authorization_superseded",
            )
          }
          await deps.refreshCatalog?.()

          log?.info("claude login completed", {
            accountId,
            mode: found.mode,
            loginStartedStatus,
            status: committed.status,
            repaired: state === "repaired",
          })
          try {
            deps.onConnected?.(accountId)
          } catch {}

          await deps.audit.record({
            kind:
              found.mode === "reconnect"
                ? AUDIT_KINDS.accountReauthorized
                : AUDIT_KINDS.accountConnected,
            subjectType: AUDIT_SUBJECTS.account,
            subjectId: accountId,
            detail: {
              label: account.value.label,
              provider: account.value.provider,
              loginStartedStatus,
              status: committed.status,
            },
          })

          return ok({
            accountId,
            mode: found.mode,
            connected: true,
            repaired: state === "repaired",
          })
        }),
      ),

    cancel: (accountId) =>
      turns.take(accountId, async () => {
        const account = await subscription(accountId)
        if (!account.ok) return account
        const found = pending.release(accountId)
        found?.handle.cancel()
        if (found !== undefined) log?.info("claude login cancelled", { accountId })
        return ok({ accountId, cancelled: found !== undefined })
      }),

    closeAdmission: () => {
      pending.stop()
      lifetime.closeAdmission()
    },
    revoke: (accountId) => {
      pending.discard(accountId)
      lifetime.revoke(accountId)
    },
    stop: () => {
      pending.stop()
      return lifetime.stop()
    },
  }
}
