import type {
  AccountBreakerRepository,
  AccountBreakerRow,
  BreakerObservation,
  ProbeHoldObservation,
} from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import { createWriterLifecycle } from "../shutdown/writer-lifecycle"
import { createJitteredRefreshTimer } from "../snapshots/timer"

export function createBreakerWriter(deps: {
  repository: AccountBreakerRepository
  logger: Logger
  flushIntervalMs: number
  shutdownDrainMs: number
  acknowledge: (input: BreakerObservation, row: AccountBreakerRow) => void
}) {
  const pending = new Map<string, { input: BreakerObservation }>()
  const pendingHolds = new Map<string, ProbeHoldObservation>()
  const active = new Map<string, { input: BreakerObservation }>()
  let inFlight: Promise<void> | undefined
  let unsettled = 0
  const warn = () =>
    deps.logger.warn("breaker persistence failed; local restrictions retained", {
      component: "account-breaker",
    })
  const drain = async () => {
    // Clocks first, then holds: a probe may be taken in the same tick as the failure that opened the
    // half-open window, and `setProbeHold` needs the breaker row that observation creates.
    for (const [id, entry] of [...pending]) {
      if (!lifecycle.canWrite()) return
      if (pending.get(id) !== entry) continue
      const { input } = entry
      pending.delete(id)
      active.set(id, entry)
      unsettled += 1
      try {
        const row = await deps.repository.observe(input)
        if (active.get(id) === entry && !pending.has(id) && row !== undefined)
          deps.acknowledge(input, row)
      } catch {
        if (active.get(id) === entry && !pending.has(id)) pending.set(id, entry)
        warn()
      } finally {
        if (active.get(id) === entry) active.delete(id)
        unsettled -= 1
      }
    }
    for (const [id, input] of [...pendingHolds]) {
      if (!lifecycle.canWrite()) return
      if (pendingHolds.get(id) !== input) continue
      pendingHolds.delete(id)
      unsettled += 1
      try {
        await deps.repository.setProbeHold(input)
      } catch {
        if (!pendingHolds.has(id)) pendingHolds.set(id, input)
        warn()
      } finally {
        unsettled -= 1
      }
    }
  }
  const flush = (): Promise<void> => {
    if (inFlight !== undefined) return inFlight
    inFlight = drain().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }
  const lifecycle = createWriterLifecycle({
    flush,
    pending: () => pending.size + pendingHolds.size,
    outstanding: () => pending.size + pendingHolds.size + unsettled,
    timeoutMs: deps.shutdownDrainMs,
    warn: (count) => deps.logger.warn("breaker shutdown incomplete", { pending: count }),
  })
  const timer = createJitteredRefreshTimer({
    intervalMs: deps.flushIntervalMs,
    refresh: flush,
    onError: warn,
  })
  return {
    record(input: BreakerObservation) {
      if (lifecycle.accepting()) pending.set(input.accountId, { input })
    },
    recordProbeHold(input: ProbeHoldObservation) {
      if (lifecycle.accepting()) pendingHolds.set(input.accountId, input)
    },
    forget(id: string) {
      active.delete(id)
      pending.delete(id)
      pendingHolds.delete(id)
    },
    flush,
    start() {
      if (lifecycle.start()) timer.start()
    },
    async stop() {
      timer.stop()
      await lifecycle.stop()
    },
  }
}
