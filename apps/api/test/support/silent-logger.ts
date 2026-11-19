import { createLogger, type Logger } from "../../src/logging/logger"

/** A real logger that writes nowhere: for a dependency a test needs but does not read. */
export function silentLogger(): Logger {
  return createLogger({ level: "error", write: () => undefined })
}
