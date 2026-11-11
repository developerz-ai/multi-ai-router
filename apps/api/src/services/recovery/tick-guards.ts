import type { RecoveryCoordinatorConfig, RecoveryRepository, RecoveryRow } from "./types"

/**
 * One queue entry's write, isolated: a throw leaves the entry queued for the next tick instead of
 * aborting the tick, so the entries behind it (outcomes, expiry, permit exposure) still run. An
 * entry that keeps failing is dropped after `maxAttempts` with a warn (plan 101, 03.11).
 */
export function createEntryIsolation(
  maxAttempts: number,
  warn: (message: string, error?: unknown) => void,
) {
  const failures = new WeakMap<object, number>()
  return async (
    entry: object,
    write: () => Promise<void>,
    drop: () => void,
    what: string,
  ): Promise<void> => {
    try {
      await write()
      failures.delete(entry)
    } catch (error) {
      const attempts = (failures.get(entry) ?? 0) + 1
      if (attempts < maxAttempts) {
        failures.set(entry, attempts)
        warn(`${what} failed; retrying next tick`, error)
        return
      }
      failures.delete(entry)
      drop()
      warn(`${what} failed ${attempts} times; dropped`, error)
    }
  }
}

/**
 * The expired-permit sweep on its own cadence. Expiry only exists `maximumOutcomeMs` after issue,
 * so it needs no tick grid: at 250 ms it was 64 % of all statements in prod with nothing pending
 * (plan 101, 10.9 / 12.13). The first call always runs, so a crashed boot's permits are settled at
 * start; a failed run is retried on the next call rather than a whole interval later.
 */
export function createExpirySweep(deps: {
  readonly intervalMs: number
  readonly now: () => number
  readonly run: () => Promise<void>
}) {
  let lastRunAt = Number.NEGATIVE_INFINITY
  return {
    runIfDue: async (): Promise<void> => {
      const now = deps.now()
      if (now - lastRunAt < deps.intervalMs) return
      await deps.run()
      lastRunAt = now
    },
  }
}

/** Issued permits past the maximum outcome bound, from any boot, become `uncertain`. */
export async function markExpiredUncertain(
  repository: Pick<RecoveryRepository, "listExpiredIssued" | "markUncertain">,
  config: Pick<RecoveryCoordinatorConfig, "batchSize" | "maximumOutcomeMs">,
  stopped: () => boolean,
  onExpired: (row: RecoveryRow) => void,
): Promise<void> {
  const rows = await repository.listExpiredIssued({
    limit: config.batchSize,
    maximumOutcomeAgeMs: config.maximumOutcomeMs,
  })
  for (const row of rows) {
    if (stopped()) return
    if (row.permitId === null) continue
    const expired = await repository.markUncertain({
      accountId: row.accountId,
      generation: row.generation,
      permitId: row.permitId,
      maximumOutcomeAgeMs: config.maximumOutcomeMs,
    })
    if (expired !== undefined) onExpired(expired)
  }
}
