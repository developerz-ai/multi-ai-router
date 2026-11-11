export interface ShutdownPhase {
  readonly name: string
  readonly run: () => void | Promise<void>
}

/** Run bounded phase APIs serially; a rejected phase never prevents the next cleanup. */
export async function runShutdownPhases(
  phases: readonly ShutdownPhase[],
  reportFailure: (phase: string, error: unknown) => void,
): Promise<boolean> {
  let succeeded = true
  for (const phase of phases) {
    try {
      await phase.run()
    } catch (error) {
      succeeded = false
      // The reason goes to the reporter, which logs through the redacting logger: a phase name
      // alone left a failed deploy with nothing to act on.
      try {
        reportFailure(phase.name, error)
      } catch {
        /* logging cannot abandon cleanup */
      }
    }
  }
  return succeeded
}

export interface ShutdownSignals {
  on(signal: "SIGTERM" | "SIGINT", callback: () => void): void
  exit(code: number): void
}

export function installFailureAwareShutdownHandlers(deps: {
  readonly lifecycle: { begin(): boolean }
  readonly signals: ShutdownSignals
  readonly shutdown: () => Promise<boolean>
  readonly log: (kind: "starting" | "repeated" | "failed", signal: string) => void
}): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    deps.signals.on(signal, () => {
      if (!deps.lifecycle.begin()) {
        try {
          deps.log("repeated", signal)
        } finally {
          deps.signals.exit(1)
        }
        return
      }
      try {
        deps.log("starting", signal)
      } catch {
        /* still attempt cleanup */
      }
      void Promise.resolve()
        .then(deps.shutdown)
        .then(
          (succeeded) => deps.signals.exit(succeeded ? 0 : 1),
          () => {
            try {
              deps.log("failed", signal)
            } finally {
              deps.signals.exit(1)
            }
          },
        )
    })
  }
}
