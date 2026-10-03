import { describeError } from "@multi-ai-router/core"
import type { Logger } from "../logging/logger"

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
      for (const phase of deps.phases) {
        const results = await Promise.allSettled(
          phase.map((step) => Promise.resolve().then(() => step.run())),
        )
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected")
            deps.logger.error("runtime shutdown step failed", {
              component: "runtime",
              step: phase[index]?.name,
              error: describeError(result.reason, Number.POSITIVE_INFINITY),
            })
        }
      }
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
          await stop()
          throw error
        })
      return starting
    },
    stop,
  }
}
