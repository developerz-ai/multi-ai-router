import type { Logger } from "../../logging/logger"

export interface CrashSignals {
  on(event: "unhandledRejection" | "uncaughtException", callback: (reason: unknown) => void): void
}

/**
 * What a stray failure does, instead of Bun's default (exit 1 at once, the raw error on stderr).
 *
 * The default cut every in-flight stream with no drain and no usage flush, and printed the error
 * past the redactor — a `postgres://user:pass@…` message verbatim. Here both events log one line
 * through the redacting logger and reach GlitchTip. A rejection nobody awaited leaves the process
 * as consistent as it was, so it keeps serving; an uncaught exception may have left any state half
 * written, so it runs the ordinary shutdown and exits non-zero.
 */
export function installCrashHandlers(deps: {
  readonly signals: CrashSignals
  readonly logger: Logger
  readonly capture: (error: unknown) => void
  /** The signal path's shutdown; resolves once the process has been told to exit. */
  readonly shutdown: () => void
}): void {
  const report = (message: string, reason: unknown) => {
    try {
      deps.logger.error(message, {
        component: "transport",
        errorClass: reason instanceof Error ? reason.name : typeof reason,
        error: reason,
      })
      deps.capture(reason)
    } catch {
      /* A failing reporter must not turn one crash into two. */
    }
  }
  deps.signals.on("unhandledRejection", (reason) => {
    report("unhandled promise rejection — serving on", reason)
  })
  deps.signals.on("uncaughtException", (error) => {
    report("uncaught exception — shutting down", error)
    deps.shutdown()
  })
}
