import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { Logger } from "../../../logging/logger"
import { redactValue } from "../../../logging/redact"
import { httpDriver } from "../../../providers"
import type { AuditRecorder } from "../../admin/audit"
import {
  type RefreshExchangeDeps,
  type RefreshFailure,
  type RefreshOutcome,
  refreshCredential,
} from "./exchange"
import { type RefreshTiming, refreshDueAt, retryDelayMs, timerDelayMs } from "./schedule"
import { parkForReauth, reviveAfterRefresh } from "./status"

/**
 * Keeping a router-held OAuth token alive: one timer per account, armed at a fraction of that
 * account's own remaining lifetime and re-armed every time a new token lands
 * (`docs/idea/01-architecture.md#credential-refresh-is-not-a-cron-job`).
 *
 * **This is deliberately not a scheduled task.** The scheduler exists for work that is periodic by
 * nature — sweeps, rollups, purges — and each of those runs on a shared interval behind an advisory
 * lock. A refresh is neither: it is due at an instant this account's own token dictates, and a poll
 * frequent enough for a ten-minute token is pure waste against a twenty-four-hour one (CLAUDE.md
 * non-negotiable 13). There is no advisory lock here either: a refresh is idempotent — every
 * replica that runs one writes a valid token set — and paying a lock round trip to avoid a
 * duplicate token request is the more expensive mistake.
 *
 * **Claude subscriptions have no timer here, and cannot get one.** Whether an account is refreshable
 * is asked of the provider registry, never of a list kept in this file: a Claude subscription is
 * served by the Agent SDK, so it has no HTTP driver and therefore no `ProviderOAuthFlow` — its
 * tokens live in its own `CLAUDE_CONFIG_DIR` and the SDK refreshes them (non-negotiable 1). The
 * same question keeps API-key accounts out, and lets a new OAuth provider in the day its driver
 * lands.
 *
 * **A failed refresh is never a failed request.** Nothing on the request path calls into this
 * module — no lazy refresh on a `401`, no awaiting a token mid-dispatch (non-negotiable 8). When a
 * refresh finally gives up, the account is parked at `needs_reauth`, which `routing/filter.ts`
 * drops from candidate selection, and the operator sees it in the console. Requests fail over to
 * the next account in the pool exactly as they would for any other unavailable one.
 *
 * **Single-flight per account.** Every trigger — a timer, a re-arm, an operator — goes through one
 * map of in-flight promises, so two triggers for the same account await one exchange and write one
 * row. Concurrency between *different* accounts is untouched.
 */

const COMPONENT = "account-refresher"
const MAX_ERROR_CHARS = 200

export interface CredentialRefreshConfig extends RefreshTiming {
  /** Transient failures tolerated before the account is parked. Retries back off, then stop. */
  readonly maxAttempts: number
  /** How long one token-endpoint call may take. */
  readonly timeoutMs: number
}

export interface CredentialRefresher {
  /** Rebuilds every timer from `tokenExpiresAt`. Awaited at boot; arms nothing it need not. */
  start(): Promise<void>
  /** Disarms every timer and awaits what is in flight, so no write outlives the pool. */
  stop(): Promise<void>
  /**
   * Re-reads one account and arms, re-arms, or disarms its timer. Called after a token lands.
   *
   * **Never rejects.** A refresher that could not re-arm must not turn a completed authorization
   * into a failed one; the problem is logged and the next boot rebuilds the schedule.
   */
  sync(accountId: string): Promise<void>
  /** The single-flight entry point: concurrent callers await one exchange. */
  refreshNow(accountId: string): Promise<RefreshOutcome>
}

export interface CredentialRefresherDeps extends Omit<RefreshExchangeDeps, "timeoutMs"> {
  readonly accounts: Pick<AccountRepository, "list" | "findById" | "update" | "updateStatus">
  readonly audit: AuditRecorder
  readonly logger: Logger
  readonly config: CredentialRefreshConfig
  /** Fired after a status write, so routing drops the account now rather than at the next TTL. */
  readonly onStatusChanged?: () => void | Promise<void>
  /** The timer seam. Defaults to `setTimeout`; a test drives its own clock through it. */
  readonly schedule?: (run: () => void, delayMs: number) => () => void
}

interface Armed {
  readonly cancel: () => void
  /** The instant the refresh is actually due, which a long lifetime reaches in several slices. */
  readonly dueAtMs: number
}

export function createCredentialRefresher(deps: CredentialRefresherDeps): CredentialRefresher {
  const timers = new Map<string, Armed>()
  const flights = new Map<string, Promise<RefreshOutcome>>()
  const attempts = new Map<string, number>()
  const schedule = deps.schedule ?? defaultSchedule
  const exchange: RefreshExchangeDeps = { ...deps, timeoutMs: deps.config.timeoutMs }
  let shutdown = new AbortController()
  let stopped = false

  const disarm = (accountId: string): void => {
    timers.get(accountId)?.cancel()
    timers.delete(accountId)
  }

  const armAt = (accountId: string, dueAtMs: number): void => {
    disarm(accountId)
    // A refresh still in flight when `stop()` is called settles and would otherwise arm its next
    // timer against a router that is already shutting down.
    if (stopped) return
    const cancel = schedule(
      () => {
        timers.delete(accountId)
        // A remaining lifetime longer than one timer can express: re-armed in slices until due.
        if (deps.now().getTime() < dueAtMs) {
          armAt(accountId, dueAtMs)
          return
        }
        void refreshNow(accountId).catch((error: unknown) => {
          deps.logger.error("credential refresh raised", {
            component: COMPONENT,
            accountId,
            error: describe(error),
          })
        })
      },
      timerDelayMs(dueAtMs, deps.now().getTime()),
    )
    timers.set(accountId, { cancel, dueAtMs })
  }

  /** Whether this row takes a timer, and arms it. See the note on the provider registry above. */
  const armFor = (row: AccountRow): boolean => {
    const refreshable =
      httpDriver(row.provider)?.oauth !== undefined &&
      row.authMaterial !== null &&
      // Both are terminal until a human acts, so a timer against either is a request that cannot
      // help: `disabled` is the operator's word, and `needs_reauth` means the grant itself is gone.
      row.status !== "disabled" &&
      row.status !== "needs_reauth"

    if (!refreshable || row.tokenExpiresAt === null) {
      disarm(row.id)
      return false
    }
    armAt(row.id, refreshDueAt(row.tokenExpiresAt, deps.now(), deps.config).getTime())
    return true
  }

  const notifyStatusChanged = async (): Promise<void> => {
    try {
      await deps.onStatusChanged?.()
    } catch (error: unknown) {
      deps.logger.warn("routing catalog refresh failed after a status change", {
        component: COMPONENT,
        error: describe(error),
      })
    }
  }

  const park = async (row: AccountRow, reason: RefreshFailure): Promise<void> => {
    deps.logger.error("credential refresh gave up; this account needs re-authorization", {
      component: COMPONENT,
      accountId: row.id,
      provider: row.provider,
      reason,
    })
    if (await parkForReauth(deps, row, reason)) await notifyStatusChanged()
  }

  const onFailure = async (row: AccountRow, reason: RefreshFailure): Promise<void> => {
    const tries = (attempts.get(row.id) ?? 0) + 1
    attempts.set(row.id, tries)

    if (reason === "unreachable" && tries < deps.config.maxAttempts) {
      deps.logger.warn("credential refresh failed; retrying", {
        component: COMPONENT,
        accountId: row.id,
        provider: row.provider,
        attempt: tries,
      })
      armAt(row.id, deps.now().getTime() + retryDelayMs(tries, deps.config.minDelayMs))
      return
    }

    disarm(row.id)
    attempts.delete(row.id)
    await park(row, reason)
  }

  const onSuccess = async (row: AccountRow, expiresAt: Date | null): Promise<void> => {
    attempts.delete(row.id)
    if (await reviveAfterRefresh(deps, row)) await notifyStatusChanged()

    if (expiresAt === null) {
      // Never guessed: this router does not invent a lifetime an issuer declined to state. The
      // account keeps working on a live token and the breaker is what eventually notices.
      deps.logger.warn("refreshed token reports no lifetime, so no refresh is scheduled", {
        component: COMPONENT,
        accountId: row.id,
        provider: row.provider,
      })
      disarm(row.id)
      return
    }
    armAt(row.id, refreshDueAt(expiresAt, deps.now(), deps.config).getTime())
  }

  const attempt = async (accountId: string): Promise<RefreshOutcome> => {
    const row = await deps.accounts.findById(accountId)
    if (row === undefined) {
      // A deleted account's timer disarms itself the first time it fires. Nothing polls for that.
      disarm(accountId)
      attempts.delete(accountId)
      return { ok: false, reason: "unknown-account" }
    }

    const flow = httpDriver(row.provider)?.oauth
    if (flow === undefined || row.status === "disabled") {
      disarm(accountId)
      attempts.delete(accountId)
      return { ok: false, reason: "not-refreshable" }
    }

    const outcome = await refreshCredential(exchange, row, flow, shutdown.signal)
    if (outcome.ok) await onSuccess(row, outcome.expiresAt)
    else await onFailure(row, outcome.reason)
    return outcome
  }

  const refreshNow = (accountId: string): Promise<RefreshOutcome> => {
    const inFlight = flights.get(accountId)
    if (inFlight !== undefined) return inFlight
    // The stored promise is the one `finally` returns, so the map is already clear by the time an
    // awaiter resumes: a caller that immediately triggers again gets a fresh exchange.
    const flight = attempt(accountId).finally(() => flights.delete(accountId))
    flights.set(accountId, flight)
    return flight
  }

  return {
    start: async () => {
      shutdown = new AbortController()
      stopped = false
      const rows = await deps.accounts.list()
      const armed = rows.filter((row) => armFor(row)).length
      deps.logger.info("credential refresh timers armed", { component: COMPONENT, accounts: armed })
    },

    stop: async () => {
      stopped = true
      shutdown.abort()
      for (const timer of timers.values()) timer.cancel()
      timers.clear()
      attempts.clear()
      // Awaited for the same reason the scheduler's stop() awaits its tick: an in-flight write
      // holds a connection the caller's pool close would otherwise cut mid-statement.
      await Promise.allSettled([...flights.values()])
    },

    sync: async (accountId) => {
      try {
        const row = await deps.accounts.findById(accountId)
        // A new token is a fresh start: whatever backoff the old one accumulated is not its debt.
        attempts.delete(accountId)
        if (row === undefined) disarm(accountId)
        else armFor(row)
      } catch (error: unknown) {
        deps.logger.warn("could not re-arm this account's refresh timer", {
          component: COMPONENT,
          accountId,
          error: describe(error),
        })
      }
    },

    refreshNow,
  }
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  // The process must be free to exit on an idle refresher, exactly as it is on an idle scheduler.
  timer.unref?.()
  return () => clearTimeout(timer)
}

/** Message only — never a stack, never a body. Scrubbed and bounded before it reaches a log line. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const scrubbed = redactValue(message)
  return scrubbed.length <= MAX_ERROR_CHARS
    ? scrubbed
    : `${scrubbed.slice(0, MAX_ERROR_CHARS - 1)}…`
}
