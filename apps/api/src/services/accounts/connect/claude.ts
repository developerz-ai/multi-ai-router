import type { AccountStatus, ProviderId } from "@multi-ai-router/core"
import type { AccountRepository } from "@multi-ai-router/db"
import type { Logger } from "../../../logging/logger"
import type { AccountConfigDirs } from "../../../providers/claude-sdk/config-dir"
import {
  type ClaudeCliLogin,
  ClaudeLoginError,
  type ClaudeLoginHandle,
  type CredentialGuard,
  parsePastedCode,
} from "../../../providers/claude-sdk/login"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../../admin/audit"
import { type AdminResult, invalid, notFound, ok } from "../../admin/result"
import { timingSafeEqualStrings } from "../../admin-auth"
import { describeProvider } from "../providers"

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
 * **Pending logins live in memory, and that is the honest store.** A pending login *is* a running
 * subprocess; a restart kills it, so persisting the `state` would only preserve a value no CLI is
 * waiting for. Same reasoning as the re-check cooldown in `../recheck.ts`.
 *
 * Reconnect is this same call against an existing row: the id, the config directory, the pool
 * membership, and the usage history all survive, because nothing here creates or replaces a row.
 */

export interface ClaudeConnectStarted {
  readonly accountId: string
  /** The CLI's own authorization URL, verbatim. The operator opens it; the router never follows it. */
  readonly authorizeUrl: string
  /** When the pending login expires and its subprocess is terminated. */
  readonly expiresAt: string
  /** Where to paste `code#state` back. Named so the console never has to hard-code a path. */
  readonly capture: "paste"
}

export interface ClaudeConnectCompleted {
  readonly accountId: string
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
  begin(accountId: string): Promise<AdminResult<ClaudeConnectStarted>>
  /** `pasted` is the whole `code#state` string from the CLI's callback page. */
  complete(accountId: string, pasted: string): Promise<AdminResult<ClaudeConnectCompleted>>
  cancel(accountId: string): Promise<AdminResult<ClaudeConnectCancelled>>
  /** Terminates every pending login. Called on shutdown so no subprocess outlives the router. */
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
}

interface Pending {
  readonly handle: ClaudeLoginHandle
  readonly configDir: string
  readonly expiresAt: Date
  readonly timer: ReturnType<typeof setTimeout>
}

export function createClaudeConnectService(deps: ClaudeConnectDeps): ClaudeConnectService {
  const pending = new Map<string, Pending>()
  const ttlMs = deps.pendingLoginMinutes * 60_000
  const log = deps.logger?.child({ component: "claude-connect" })

  /** Removes and terminates a pending login. The only way one is ever released. */
  const release = (accountId: string): Pending | undefined => {
    const found = pending.get(accountId)
    if (found === undefined) return undefined
    pending.delete(accountId)
    clearTimeout(found.timer)
    return found
  }

  const discard = (accountId: string): void => {
    release(accountId)?.handle.cancel()
  }

  const subscription = async (accountId: string): Promise<AdminResult<SubscriptionAccount>> => {
    const row = await deps.accounts.findById(accountId)
    if (row === undefined) return notFound(`no account with id "${accountId}"`)
    if (!describeProvider(row.provider).requiresConfigDir) {
      return invalid(
        `account "${row.label}" is a ${row.provider} account: only Claude subscription accounts are connected through the claude CLI`,
        "not_a_subscription_account",
      )
    }
    return ok({ id: row.id, label: row.label, provider: row.provider, status: row.status })
  }

  return {
    begin: async (accountId) => {
      const account = await subscription(accountId)
      if (!account.ok) return account

      // A second `begin` supersedes the first: one Account has one pending login, and leaving the
      // old subprocess running would mean two live states for one row.
      discard(accountId)

      // Idempotent, and it re-asserts `0700` on a directory that already exists — a login must
      // never be the thing that discovers the directory was never made.
      const configDir = await deps.configDirs.provision(accountId)

      let handle: ClaudeLoginHandle
      try {
        handle = await deps.login.start({ configDir })
      } catch (error) {
        return loginFailure(error, accountId, log)
      }

      const expiresAt = new Date(deps.now().getTime() + ttlMs)
      const timer = setTimeout(() => discard(accountId), ttlMs)
      timer.unref?.()
      pending.set(accountId, { handle, configDir, expiresAt, timer })

      return ok({
        accountId,
        authorizeUrl: handle.authorizeUrl,
        expiresAt: expiresAt.toISOString(),
        capture: "paste",
      })
    },

    complete: async (accountId, pasted) => {
      const account = await subscription(accountId)
      if (!account.ok) return account

      // Consumed before it is checked. One-shot means a mismatched or expired paste burns the
      // login too — otherwise a wrong value is just a retry, which is the whole attack this guard
      // exists to stop (docs/idea/07-security.md).
      const found = release(accountId)
      if (found === undefined) {
        return invalid(
          "no login is pending for this account — start one and paste the code within the window",
          "no_pending_login",
        )
      }

      if (deps.now() >= found.expiresAt) {
        found.handle.cancel()
        return invalid("that login expired — start a new one", "login_expired")
      }

      const parsed = parsePastedCode(pasted)
      if (parsed === null) {
        found.handle.cancel()
        // Says what the value looks like, never what was pasted: the paste is credential material.
        return invalid(
          "paste the whole value from the authorization page, in the form code#state",
          "malformed_paste",
        )
      }
      if (!timingSafeEqualStrings(parsed.state, found.handle.state)) {
        found.handle.cancel()
        return invalid(
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
        return invalid(
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

      await deps.audit.record({
        kind: AUDIT_KINDS.accountConnected,
        subjectType: AUDIT_SUBJECTS.account,
        subjectId: accountId,
        // Names and flags. There is no field here that could hold a code, a state, or a token.
        detail: { label: account.value.label, provider: account.value.provider, previousStatus },
      })

      return ok({ accountId, connected: true, repaired: state === "repaired" })
    },

    cancel: async (accountId) => {
      const account = await subscription(accountId)
      if (!account.ok) return account
      const found = release(accountId)
      found?.handle.cancel()
      return ok({ accountId, cancelled: found !== undefined })
    },

    stop: () => {
      for (const accountId of [...pending.keys()]) discard(accountId)
    },
  }
}

interface SubscriptionAccount {
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
function loginFailure(error: unknown, accountId: string, log?: Logger): AdminResult<never> {
  if (!(error instanceof ClaudeLoginError)) throw error
  log?.warn("claude cli login failed", {
    accountId,
    kind: error.kind,
    ...(error.logDetail === null ? {} : { cliOutput: error.logDetail }),
  })
  return invalid(error.message, `claude_login_${error.kind}`)
}
