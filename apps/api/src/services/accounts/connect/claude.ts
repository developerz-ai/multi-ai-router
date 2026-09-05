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

/**
 * Connecting — and reconnecting — one Claude subscription Account.
 *
 * The flow is two admin calls with a live `claude` subprocess between them: `begin` provisions the
 * Account's `CLAUDE_CONFIG_DIR`, starts the CLI's own login against it, and hands back the
 * authorization URL the CLI printed. The operator authorizes in a browser and pastes `code#state`
 * back; `complete` checks the paste against this Account's pending login and writes it to the CLI's
 * stdin, which does the exchange and writes its own credentials.
 *
 * **Manual paste is the mechanism, not a fallback.** There is no redirect capture here at all: the
 * CLI owns the redirect URI, and a router callback would mean intercepting a code meant for the
 * CLI. So the flow that works with no reachable `PUBLIC_URL` is the only flow, which is also why it
 * is the one that gets the checks (docs/idea/03-providers.md, docs/idea/09-deployment.md).
 *
 * **What the router owns, and it is deliberately little.** The PKCE `code_verifier` is minted
 * inside the subprocess and never crosses back — there is no field on this side that could hold
 * it. The `state` does cross back, read out of the authorize URL, because the checks it enables are
 * nobody else's: one-shot, TTL-bounded, and bound to this Account's row
 * (docs/idea/07-security.md#oauth-flow-safety). No token, no code, and no credential material is
 * returned, logged, or audited by anything in this file.
 *
 * **Pending logins live in memory** (`./claude-pending.ts`), and that is the honest store: a pending
 * login *is* a running subprocess. Same reasoning as the re-check cooldown in `../recheck.ts`.
 *
 * **A completed login lifts the whole `needs_reauth` verdict, not half of it.** The request path
 * parks a dead subscription twice — the row (`status-writer.ts`) and the breaker's `blocked` phase in
 * this process's health store — and the accounts read overlays the second onto the first. Clearing
 * only the row left three freshly reconnected subscriptions reading `needs_reauth` in the console
 * until an operator pressed Re-check, whose `health.reset` is exactly what was missing. So
 * completion calls that same `reset` and the same catalog refresh: one code path for "this account
 * is eligible again", whichever button reached it.
 *
 * **Every call that touches that store takes the account's turn** (`./turns.ts`). All three of them
 * read the one pending login and then replace it, with a subprocess spawn or a stdin write in
 * between — so without a queue two concurrent calls interleave into two live CLIs for one
 * `CLAUDE_CONFIG_DIR`, one of them orphaned and its expiry timer aimed at the other.
 *
 * Reconnect is this same call against an existing row: the id, the config directory, the pool
 * membership, and the usage history all survive, because nothing here creates or replaces a row.
 * The {@link ClaudeConnectMode} changes nothing about what runs — it is the operator saying which
 * of the two they meant, carried through so the audit log can tell a first login from a repair.
 */

/**
 * Which button was pressed. Not derived: "has this directory a credential in it already" is a
 * question only the CLI can answer, and spawning it to label an audit row would double the cost of
 * every connect to decide a word.
 */
export type ClaudeConnectMode = "connect" | "reconnect"

export interface ClaudeConnectStarted {
  readonly accountId: string
  readonly mode: ClaudeConnectMode
  /** The CLI's own authorization URL, verbatim. The operator opens it; the router never follows it. */
  readonly authorizeUrl: string
  /** When the pending login expires and its subprocess is terminated. */
  readonly expiresAt: string
  /** Where to paste `code#state` back. Named so the console never has to hard-code a path. */
  readonly capture: "paste"
}

export interface ClaudeConnectCompleted {
  readonly accountId: string
  readonly mode: ClaudeConnectMode
  readonly connected: true
  /** True when the credential file needed re-minifying to be readable — see `login/credentials.ts`. */
  readonly repaired: boolean
}

export interface ClaudeConnectCancelled {
  readonly accountId: string
  /** False when there was nothing pending, which is not an error — the desired state already held. */
  readonly cancelled: boolean
}

export interface ClaudeConnectService {
  begin(accountId: string, mode: ClaudeConnectMode): Promise<AdminResult<ClaudeConnectStarted>>
  /** `pasted` is the whole `code#state` string from the CLI's callback page. */
  complete(accountId: string, pasted: string): Promise<AdminResult<ClaudeConnectCompleted>>
  cancel(accountId: string): Promise<AdminResult<ClaudeConnectCancelled>>
  /**
   * Terminates every pending login and refuses any still starting. Called on shutdown, so no
   * `claude` subprocess outlives the router — including one whose CLI had not printed its URL yet.
   */
  stop(): void
}

export interface ClaudeConnectDeps {
  readonly accounts: Pick<AccountRepository, "findById" | "update">
  readonly configDirs: AccountConfigDirs
  readonly login: ClaudeCliLogin
  readonly credentials: CredentialGuard
  readonly audit: AuditRecorder
  /** The one-shot window, in minutes. Config, never a constant — `env.retention.oauthStateMinutes`. */
  readonly pendingLoginMinutes: number
  /**
   * Where a failed login's diagnostic tail goes. Absent means it is dropped, which is a worse
   * deployment but never a leak: the field is redacted at its source and again by the logger.
   */
  readonly logger?: Logger
  readonly now: () => Date
  /**
   * The live half of the verdict a login lifts — the same `reset` the Re-check button calls (see the
   * module comment). Optional so a test of the paste flow alone need not build a health store; the
   * composition root always wires it.
   */
  readonly health?: Pick<HealthStore, "reset">
  /**
   * Re-reads the warm routing catalog once the row changed, so the console's next read — which
   * happens the instant `complete` answers — sees `active` rather than the status it just lifted.
   */
  readonly refreshCatalog?: () => Promise<void>
  /**
   * Fired after a login has landed and the account is eligible again. For anything that wants to
   * learn about the fresh credential without this service knowing what — the subscription's model
   * list, today. Fire-and-forget: a completion never waits on it and never fails because of it.
   */
  readonly onConnected?: (accountId: string) => void
}

export function createClaudeConnectService(deps: ClaudeConnectDeps): ClaudeConnectService {
  const pending = createPendingLogins()
  const turns = createAccountTurns()
  const ttlMs = deps.pendingLoginMinutes * 60_000
  const log = deps.logger?.child({ component: "claude-connect" })

  /**
   * Every refusal of a paste, logged before it is answered. The operator sees the message; the
   * pod log — which showed nothing at all for a six-account reconnect — gets the code and the
   * account, and never the paste itself.
   */
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
        pending.hold(accountId, { handle, configDir, mode, expiresAt }, ttlMs)
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

        // `needs_reauth` is the one status a login clears. Nothing else is touched: an account the
        // operator disabled stays disabled, and re-connecting is not a way around that.
        const previousStatus = account.value.status
        if (previousStatus === "needs_reauth") {
          await deps.accounts.update(accountId, { status: "active" }, deps.now())
        }
        // Whatever the row said: the health store may hold a `blocked` verdict the row never did (a
        // failed write-through, a manual flip), and a fresh login is the one event that makes it
        // stale. Same call as Re-check, so the two cannot disagree — see the module comment.
        deps.health?.reset(accountId)
        // Awaited, like `recheck` does: the console re-reads the list the moment this answers.
        if (previousStatus === "needs_reauth") await deps.refreshCatalog?.()

        log?.info("claude login completed", {
          accountId,
          mode: found.mode,
          previousStatus,
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
          detail: { label: account.value.label, provider: account.value.provider, previousStatus },
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
