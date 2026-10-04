import type { Logger } from "../logging/logger"

export class RuntimeShutdownFailure extends Error {
  constructor(readonly steps: readonly string[]) {
    super("runtime cleanup failed")
    this.name = "RuntimeShutdownFailure"
  }
}

interface ShutdownStep {
  readonly name: string
  run(): void | Promise<void>
}
/** Auxiliary lock handles close permanently; one runtime has one start/stop lifecycle. */
export function createRuntimeLifecycle(deps: {
  logger: Logger
  start(assertStarting: () => void): Promise<void>
  phases: readonly (readonly ShutdownStep[])[]
}): { start(): Promise<void>; stop(): Promise<void> } {
  let stopped = false
  let starting: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  const assertStarting = () => {
    if (stopped) throw new Error("runtime stopped during startup")
  }
  const stop = () => {
    if (stopping !== undefined) return stopping
    stopped = true
    stopping = (async () => {
      const failed: string[] = []
      for (const phase of deps.phases) {
        const results = await Promise.allSettled(
          phase.map((step) => Promise.resolve().then(() => step.run())),
        )
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected") {
            const step = phase[index]?.name ?? "unknown"
            failed.push(step)
            try {
              deps.logger.error("runtime shutdown step failed", {
                component: "runtime",
                step,
                errorClass: "runtime_shutdown_failure",
              })
            } catch {
              /* Continue cleanup even if logging fails. */
            }
          }
        }
      }
      if (failed.length > 0) throw new RuntimeShutdownFailure(Object.freeze(failed))
    })()
    return stopping
  }
  return {
    start: () => {
      if (stopped) return Promise.reject(new Error("cannot restart a stopped runtime"))
      if (starting !== undefined) return starting
      starting = Promise.resolve()
        .then(() => {
          assertStarting()
          return deps.start(assertStarting)
        })
        .catch(async (error) => {
          try {
            await stop()
          } catch {
            /* Preserve the original startup failure. */
          }
          throw error
        })
      return starting
    },
    stop,
  }
}
