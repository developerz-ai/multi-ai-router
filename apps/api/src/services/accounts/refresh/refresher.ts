import type { AccountRepository, AccountRow, CredentialRefreshLock } from "@multi-ai-router/db"
import type { Logger } from "../../../logging/logger"
import { httpDriver } from "../../../providers"
import type { AuditRecorder } from "../../admin/audit"
import { createRefreshCoherence } from "./coherence"
import { defaultSchedule, drainRefreshWork } from "./drain"
import { type RefreshExchangeDeps, type RefreshOutcome, refreshCredential } from "./exchange"
import {
  type RefreshExpectation as Expectation,
  eligible,
  expectation,
  matches,
  type RefreshFlightObservation,
  type RefreshTimerState as Timing,
} from "./identity"
import { createRefreshSafety, refreshErrorLogger } from "./safety"
import { refreshDueAt, retryDelayMs } from "./schedule"
import { parkForReauth, sameObservation } from "./status"
import { createRefreshTimers } from "./timers"

export type { CredentialRefreshConfig, CredentialRefresher } from "./types"

import type { CredentialRefreshConfig, CredentialRefresher } from "./types"
export interface CredentialRefresherDeps extends Omit<RefreshExchangeDeps, "timeoutMs"> {
  readonly accounts: Pick<
    AccountRepository,
    "list" | "findById" | "saveRefreshedCredential" | "transitionObservedStatus"
  >
  readonly refreshLock: Pick<CredentialRefreshLock, "tryRun">
  readonly refreshCatalogAfterMutation: () => Promise<void>
  readonly audit: AuditRecorder
  readonly logger: Logger
  readonly config: CredentialRefreshConfig
  readonly schedule?: (run: () => void, delayMs: number) => () => void
}

export function createCredentialRefresher(deps: CredentialRefresherDeps): CredentialRefresher {
  const timings = new Map<string, Timing>()
  const flights = new Map<string, Promise<RefreshOutcome>>()
  const reads = new Map<string, number>()
  const schedule = deps.schedule ?? defaultSchedule
  const exchange = { ...deps, timeoutMs: deps.config.timeoutMs }
  let shutdown = new AbortController()
  let readVersion = 0
  let stopped = false
  let abandoned = false
  let stopping: Promise<void> | undefined

  const forget = (id: string): void => {
    disarm(id)
    timings.delete(id)
  }
  const log = refreshErrorLogger(deps.logger)
  const coherence = createRefreshCoherence({
    refresh: deps.refreshCatalogAfterMutation,
    schedule,
    minDelayMs: deps.config.minDelayMs,
    onError: (error) => log("routing catalog refresh failed after credential mutation", error),
  })
  const barrier = coherence.changed
  const timers = createRefreshTimers({
    schedule,
    now: deps.now,
    stopped: () => stopped,
    timing: (id) => timings.get(id),
    due: (id, timing) => {
      void run(id, timing).catch((error) => log("credential refresh raised", error, id))
    },
  })
  const { disarm, armAt, defer } = timers
  const safety = createRefreshSafety({
    timings,
    armAt,
    disarm,
    now: deps.now,
    minDelayMs: deps.config.minDelayMs,
    log,
    barrier,
    abandoned: () => abandoned,
  })
  const armFor = (row: AccountRow, settling = false): void => {
    if (safety.blocked(row) || !eligible(row) || row.tokenExpiresAt === null) {
      forget(row.id)
      return
    }
    const held = timings.get(row.id)
    if (held !== undefined && matches(held, row)) {
      held.lifecycleVersion = row.lifecycleVersion
      if (held.pausedLifecycleVersion !== undefined) {
        if (held.pausedLifecycleVersion === row.lifecycleVersion) {
          disarm(row.id)
          return
        }
        delete held.pausedLifecycleVersion
        held.attempts = 0
        held.dueAtMs = Math.max(held.dueAtMs, deps.now().getTime() + deps.config.minDelayMs)
      }
      if (!timers.has(row.id) && (settling || !flights.has(row.id))) armAt(row.id, held)
      return
    }
    const timing: Timing = {
      ...expectation(row),
      attempts: 0,
      lifecycleVersion: row.lifecycleVersion,
      dueAtMs: refreshDueAt(row.tokenExpiresAt, deps.now(), deps.config).getTime(),
    }
    timings.set(row.id, timing)
    armAt(row.id, timing)
  }
  const sync = async (id: string, settling = false): Promise<void> => {
    const version = ++readVersion
    reads.set(id, version)
    try {
      const row = await deps.accounts.findById(id)
      if (reads.get(id) !== version || stopped) return
      if (row === undefined) {
        safety.deleted(id)
        forget(id)
      } else armFor(row, settling)
    } catch (error) {
      if (reads.get(id) === version && !stopped && !timers.has(id)) safety.retryHeld(id)
      log("could not reconcile credential refresh timer", error, id)
    } finally {
      if (reads.get(id) === version) reads.delete(id)
    }
  }
  const apply = async (
    id: string,
    outcome: RefreshOutcome,
    expected: Expectation,
    signal: AbortSignal,
  ): Promise<RefreshOutcome> => {
    if (abandoned) return outcome
    if (outcome.kind === "success") {
      await barrier()
      return outcome
    }
    if (outcome.kind === "skipped") {
      if (
        outcome.reason === "busy" ||
        outcome.reason === "superseded" ||
        outcome.reason === "aborted"
      ) {
        defer(id, expected, deps.config.minDelayMs)
      }
      return outcome
    }
    if (signal.aborted) return { kind: "skipped", reason: "aborted", row: outcome.observed }
    const latest = await deps.accounts.findById(id)
    if (signal.aborted) return { kind: "skipped", reason: "aborted" }
    if (latest === undefined || !sameObservation(latest, outcome.observed)) {
      defer(id, expected, deps.config.minDelayMs)
      return {
        kind: "skipped",
        reason: "superseded",
        ...(latest === undefined ? {} : { row: latest }),
      }
    }
    const timing = timings.get(id)
    const tries = timing !== undefined && matches(timing, latest) ? ++timing.attempts : 1
    if (outcome.reason === "unreachable" && tries < deps.config.maxAttempts) {
      defer(id, expected, retryDelayMs(tries, deps.config.minDelayMs))
      return outcome
    }
    if (latest.status === "exhausted") {
      if (
        timing === undefined ||
        !matches(timing, latest) ||
        !matches(expected, latest) ||
        timing.lifecycleVersion !== latest.lifecycleVersion
      )
        return { kind: "skipped", reason: "superseded" }
      timing.pausedLifecycleVersion = latest.lifecycleVersion
      disarm(id)
      return outcome
    }
    const committed = await parkForReauth(
      { ...deps, refreshCatalogAfterMutation: barrier, canFinalize: () => !abandoned },
      outcome.observed,
      outcome.reason,
    )
    if (committed === undefined) {
      defer(id, expected, deps.config.minDelayMs)
      return { kind: "skipped", reason: "superseded" }
    }
    return outcome
  }
  const attempt = async (
    id: string,
    expected: Expectation,
    signal: AbortSignal,
    observation: RefreshFlightObservation,
  ): Promise<RefreshOutcome> => {
    const locked = await deps.refreshLock.tryRun(id, signal, async (lockSignal) => {
      const row = await deps.accounts.findById(id)
      if (lockSignal.aborted) return { kind: "skipped", reason: "aborted" } as const
      if (row === undefined) return { kind: "skipped", reason: "unknown-account" } as const
      if (safety.blocked(row)) return { kind: "skipped", reason: "not-refreshable", row } as const
      if (!matches(expected, row)) return { kind: "skipped", reason: "superseded", row } as const
      const flow = httpDriver(row.provider)?.oauth
      if (flow === undefined || !eligible(row))
        return { kind: "skipped", reason: "not-refreshable", row } as const
      observation.row = row
      observation.exchangeStarted = true
      const outcome = await refreshCredential(exchange, row, flow, lockSignal)
      observation.exchangeFinished = true
      return outcome
    })
    return apply(
      id,
      locked.acquired ? locked.value : { kind: "skipped", reason: locked.reason },
      expected,
      signal,
    )
  }
  const run = (id: string, expected?: Expectation): Promise<RefreshOutcome> => {
    if (stopped) return Promise.resolve({ kind: "skipped", reason: "aborted" })
    const existing = flights.get(id)
    if (existing !== undefined) return existing
    const signal = shutdown.signal
    const observation: RefreshFlightObservation = { exchangeStarted: false }
    let requested = expected
    const flight: Promise<RefreshOutcome> = (async (): Promise<RefreshOutcome> => {
      const row = expected === undefined ? await deps.accounts.findById(id) : undefined
      if (signal.aborted) return { kind: "skipped", reason: "aborted" }
      if (expected === undefined && row === undefined)
        return { kind: "skipped", reason: "unknown-account" }
      if (row !== undefined) {
        armFor(row)
        requested = expectation(row)
      }
      return attempt(id, requested ?? expectation(row as AccountRow), signal, observation)
    })()
      .catch(async (error) => {
        await safety.failed(id, requested, observation, signal.aborted, error)
        throw error
      })
      .finally(async () => {
        try {
          if (!signal.aborted) await sync(id, true)
        } finally {
          if (flights.get(id) === flight) {
            flights.delete(id)
            if (!stopped && !timers.has(id)) safety.retryHeld(id)
          }
        }
      })
    flights.set(id, flight)
    return flight
  }
  return {
    start: async () => {
      if (stopping !== undefined) await stopping
      if (flights.size > 0)
        throw new Error("cannot restart while abandoned refresh work is pending")
      if (stopped) {
        shutdown = new AbortController()
        stopped = false
        abandoned = false
      }
      coherence.start()
      const rows = await deps.accounts.list()
      if (stopped) return
      for (const row of rows) armFor(row)
    },
    stop: () => {
      if (stopping !== undefined) return stopping
      if (stopped && abandoned) return Promise.resolve()
      stopped = true
      shutdown.abort()
      coherence.stopTimers()
      timers.clear()
      timings.clear()
      const draining = Promise.allSettled([...flights.values()]).then(() => coherence.drain())
      stopping = drainRefreshWork(
        draining,
        deps.config.shutdownDrainMs ?? deps.config.timeoutMs,
        schedule,
      )
        .then((complete) => {
          if (!complete) {
            abandoned = true
            deps.logger.warn("credential refresh drain timed out; grant persistence is uncertain", {
              component: "account-refresher",
              flights: flights.size,
            })
          }
        })
        .finally(() => {
          stopping = undefined
        })
      return stopping
    },
    sync,
    refreshNow: (id) => run(id),
  }
}
