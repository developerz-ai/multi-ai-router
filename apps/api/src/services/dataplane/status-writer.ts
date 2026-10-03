import { type AccountStatus, describeError } from "@multi-ai-router/core"
import type { AccountRepository } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import { type HealthObservation, newerObservation } from "./health-observation"

export type ObservedAccountStatus = "exhausted" | "needs_reauth"

export function persistable(status: AccountStatus): status is ObservedAccountStatus {
  return status === "exhausted" || status === "needs_reauth"
}

export const OVERWRITABLE_BY_OBSERVATION: readonly AccountStatus[] = ["active", "cooling_down"]

export interface AccountStatusWriterDeps {
  readonly accounts: Pick<AccountRepository, "transitionObservedStatus">
  readonly logger: Logger
  readonly flushIntervalMs: number
  readonly now: () => Date
}

export interface AccountStatusWriterStats {
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
    { status: ObservedAccountStatus; observation: HealthObservation }
  >()

  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<void> | null = null
  let written = 0
  let refused = 0
  let writeFailures = 0

  const drain = async (): Promise<void> => {
    if (pending.size === 0) return
    const batch = [...pending.entries()]
    pending.clear()

    let failed = 0
    let lastError: unknown = null

    for (const [accountId, { status, observation }] of batch) {
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
        writeFailures += 1
        lastError = error
        failed += 1
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
    })
    inFlight = run
    return run
  }

  return {
    record(accountId, status, observation) {
      if (!persistable(status) || !OVERWRITABLE_BY_OBSERVATION.includes(observation.status)) return
      const previous = pending.get(accountId)
      if (previous !== undefined && !newerObservation(observation, previous.observation)) return
      pending.set(accountId, { status, observation })
    },

    forget(accountId) {
      pending.delete(accountId)
    },

    flush,

    start() {
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
      await flush()
    },

    stats: () => ({ pending: pending.size, written, refused, writeFailures }),
  }
}
