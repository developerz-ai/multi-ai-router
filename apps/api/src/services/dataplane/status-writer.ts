import { type AccountStatus, describeError } from "@multi-ai-router/core"
import type { AccountRepository } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import { createWriterLifecycle } from "../shutdown/writer-lifecycle"
import { type HealthObservation, newerObservation } from "./health-observation"

export type ObservedAccountStatus = "exhausted" | "needs_reauth"

export function persistable(status: AccountStatus): status is ObservedAccountStatus {
  return status === "exhausted" || status === "needs_reauth"
}

export const OVERWRITABLE_BY_OBSERVATION: readonly AccountStatus[] = ["active", "cooling_down"]

export interface AccountStatusWriterDeps {
  readonly accounts: Pick<AccountRepository, "transitionObservedStatus">
  readonly logger: Logger
  readonly shutdownDrainMs?: number
  readonly flushIntervalMs: number
  readonly now: () => Date
}

export interface AccountStatusWriterStats {
  readonly rejectedAfterStop: number
  readonly pending: number
  readonly written: number
  readonly refused: number
  readonly writeFailures: number
}

export interface AccountStatusWriter {
  record(accountId: string, status: AccountStatus, observation: HealthObservation): void
  forget(accountId: string): void
  flush(): Promise<void>
  start(): void
  stop(): Promise<void>
  stats(): AccountStatusWriterStats
}

export function createAccountStatusWriter(deps: AccountStatusWriterDeps): AccountStatusWriter {
  const log = deps.logger.child({ component: "account-status" })
  const pending = new Map<
    string,
    { status: ObservedAccountStatus; observation: HealthObservation; forgottenVersion: number }
  >()

  const forgotten = new Map<string, number>()

  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<void> | null = null
  let unsettled = 0
  let rejectedAfterStop = 0
  let written = 0
  let refused = 0
  let writeFailures = 0

  const drain = async (): Promise<void> => {
    if (pending.size === 0) return
    const batch = [...pending.entries()]
    pending.clear()
    unsettled = batch.length

    let failed = 0
    let lastError: unknown = null

    for (const [accountId, { status, observation, forgottenVersion }] of batch) {
      if (!lifecycle.canWrite()) {
        const newer = pending.get(accountId)
        if (
          (forgotten.get(accountId) ?? 0) === forgottenVersion &&
          (newer === undefined || newerObservation(observation, newer.observation))
        ) {
          pending.set(accountId, { status, observation, forgottenVersion })
        }
        unsettled -= 1
        continue
      }
      try {
        const row = await deps.accounts.transitionObservedStatus({
          id: accountId,
          expected: {
            lifecycleVersion: observation.lifecycleVersion,
            authMaterial: observation.authMaterial,
            status: observation.status,
            recoveryGeneration: observation.recoveryGeneration,
          },
          status,
          now: deps.now(),
        })
        if (row === undefined) {
          refused += 1
          continue
        }
        written += 1
        log.warn("account parked by the router", { accountId, status })
      } catch (error) {
        const newer = pending.get(accountId)
        if (
          (forgotten.get(accountId) ?? 0) === forgottenVersion &&
          (newer === undefined || newerObservation(observation, newer.observation))
        ) {
          pending.set(accountId, { status, observation, forgottenVersion })
        }
        writeFailures += 1
        lastError = error
        failed += 1
      } finally {
        unsettled -= 1
      }
    }

    if (failed > 0) {
      log.warn("account status writes failed — routing holds the verdict, stored rows lag", {
        accounts: failed,
        reason: describeError(lastError, Number.POSITIVE_INFINITY),
      })
    }
  }

  const flush = (): Promise<void> => {
    if (inFlight !== null) return inFlight
    const run = drain().finally(() => {
      inFlight = null
      unsettled = 0
    })
    inFlight = run
    return run
  }

  const lifecycle = createWriterLifecycle({
    flush,
    pending: () => pending.size,
    outstanding: () => pending.size + unsettled,
    timeoutMs: deps.shutdownDrainMs ?? 15_000,
    warn: (pending) =>
      log.warn("writer shutdown incomplete; unconfirmed writes remain", { pending }),
  })

  return {
    record(accountId, status, observation) {
      if (!lifecycle.accepting()) {
        rejectedAfterStop += 1
        return
      }
      if (!persistable(status) || !OVERWRITABLE_BY_OBSERVATION.includes(observation.status)) return
      const previous = pending.get(accountId)
      if (previous !== undefined && !newerObservation(observation, previous.observation)) return
      pending.set(accountId, {
        status,
        observation,
        forgottenVersion: forgotten.get(accountId) ?? 0,
      })
    },

    forget(accountId) {
      forgotten.set(accountId, (forgotten.get(accountId) ?? 0) + 1)
      pending.delete(accountId)
    },

    flush,

    start() {
      if (!lifecycle.start()) return
      if (timer !== null) return
      timer = setInterval(() => {
        void flush()
      }, deps.flushIntervalMs)
      timer.unref?.()
    },

    async stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      await lifecycle.stop()
    },

    stats: () => ({ rejectedAfterStop, pending: pending.size, written, refused, writeFailures }),
  }
}
