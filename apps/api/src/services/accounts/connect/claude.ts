import type { AccountRepository } from "@multi-ai-router/db"
import type { Logger } from "../../../logging/logger"
import type { AccountConfigDirs } from "../../../providers/claude-sdk/config-dir"
import {
  type ClaudeCliLogin,
  type ClaudeLoginHandle,
  type CredentialGuard,
  parsePastedCode,
} from "../../../providers/claude-sdk/login"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../../admin/audit"
import { type AdminResult, conflict, invalid, ok } from "../../admin/result"
import { timingSafeEqualStrings } from "../../admin-auth"
import type { HealthStore } from "../../dataplane"
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
  stop(): void
}

export interface ClaudeConnectDeps {
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

  const rejected = (accountId: string, message: string, code: string): AdminResult<never> => {
    log?.info("claude login rejected", { accountId, code })
    return invalid(message, code)
  }

  const subscription = (accountId: string): Promise<AdminResult<SubscriptionAccount>> =>
    findSubscriptionAccount(deps.accounts, accountId)

  return {
    // In the account's turn: reads the pending login, then replaces it, two awaits later
    // (`./turns.ts` — that window is what let two `begin`s produce two live CLIs for one row).
    begin: (accountId, mode) =>
      turns.take(accountId, async () => {
        const account = await subscription(accountId)
        if (!account.ok) return account

        // A second `begin` supersedes the first: one Account has one pending login, and leaving the
        // old subprocess running would mean two live states for one row. Queued, so what this
        // displaces is always a registered login and never one still starting.
        pending.discard(accountId)

        // Idempotent, and it re-asserts `0700` on a directory that already exists — a login must
        // never be the thing that discovers the directory was never made.
        const configDir = await deps.configDirs.provision(accountId)

        let handle: ClaudeLoginHandle
        try {
          handle = await deps.login.start({ configDir })
        } catch (error) {
          return loginFailure(error, accountId, log)
        }

        // `stop()` is synchronous and cannot reach a CLI that has not printed its URL yet, so the
        // check belongs where the handle first exists: the login shutdown could not see is the one
        // that would outlive the router.
        if (pending.stopping) {
          handle.cancel()
          return conflict(
            "this router is shutting down — connect this account once it is back",
            "shutting_down",
          )
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

    // The turn is held for the whole exchange, not just the claim: a `begin` admitted mid-submit
    // would put a second CLI on the directory this one is about to write `.credentials.json` into.
    complete: (accountId, pasted) =>
      turns.take(accountId, async () => {
        const account = await subscription(accountId)
        if (!account.ok) return account

        // Consumed before it is checked. One-shot means a mismatched or expired paste burns the
        // login too — otherwise a wrong value is just a retry, which is the whole attack this guard
        // exists to stop (docs/idea/07-security.md).
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
          // Says what the value looks like, never what was pasted: the paste is credential material.
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

        const state = await deps.credentials.settle(found.configDir)
        if (state === "absent" || state === "unreadable") {
          return rejected(
            accountId,
            "the claude CLI finished without leaving a usable credential — start the login again",
            "no_credential",
          )
        }

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
        } catch {
          // A listener's failure is its own; the login landed regardless.
        }

        await deps.audit.record({
          kind:
            found.mode === "reconnect"
              ? AUDIT_KINDS.accountReauthorized
              : AUDIT_KINDS.accountConnected,
          subjectType: AUDIT_SUBJECTS.account,
          subjectId: accountId,
          // Names and flags. There is no field here that could hold a code, a state, or a token.
          detail: {
            label: account.value.label,
            provider: account.value.provider,
            loginStartedStatus,
            status: committed.status,
          },
        })

        return ok({ accountId, mode: found.mode, connected: true, repaired: state === "repaired" })
      }),

    // Also queued: an operator who cancels while the CLI is still starting means "leave nothing
    // pending", and answering that before the login exists would report a cancel that cancelled
    // nothing and then let the subprocess register anyway.
    cancel: (accountId) =>
      turns.take(accountId, async () => {
        const account = await subscription(accountId)
        if (!account.ok) return account
        const found = pending.release(accountId)
        found?.handle.cancel()
        if (found !== undefined) log?.info("claude login cancelled", { accountId })
        return ok({ accountId, cancelled: found !== undefined })
      }),

    // The registry sets its flag first: a login still inside `login.start` cannot be terminated from
    // here, so it reads that flag when its handle appears and terminates itself.
    stop: pending.stop,
  }
}
