import type { ShutdownPhase } from "./run-phases"

export interface ShutdownSteps {
  /** Waits out `SHUTDOWN_READY_GRACE_MS` while `/readyz` already answers `503`. */
  readonly announceUnready: () => Promise<void>
  /** Turns new data-plane requests away with a typed `503`. */
  readonly closeAdmission: () => void
  /** Closes the listener and waits, bounded, for responses in flight. */
  readonly drainHttp: () => Promise<void>
  readonly stopRuntime: () => Promise<void>
  readonly closeDatabase: () => Promise<void>
}

/**
 * The shutdown order, as data so it is testable.
 *
 * Readiness fails first and admission stays open through the grace: the window exists so a
 * request that still arrives while the balancer notices is *served*. Closing admission before it
 * turned the whole grace into guaranteed `503`s (2026-11-10: 22 per rollout). Admission closes
 * immediately before the listener does, so nothing new starts once the drain is under way.
 */
export function shutdownPhases(steps: ShutdownSteps): readonly ShutdownPhase[] {
  return [
    { name: "readiness-grace", run: steps.announceUnready },
    { name: "admission", run: steps.closeAdmission },
    { name: "http-drain", run: steps.drainHttp },
    { name: "runtime", run: steps.stopRuntime },
    { name: "database", run: steps.closeDatabase },
  ]
}
