import type { LogLevel } from "../config/env"
import { redact, redactValue } from "./redact"

/**
 * Structured JSON logs, one object per line on stdout. No `console.log` anywhere in the router.
 * Every field passed in is redacted before it is serialized — see `redact.ts`.
 * Field contract: docs/idea/08-observability.md#structured-logging.
 *
 * `msg` goes through the value-level scrub too. Every call site today passes a constant, which is
 * exactly why this is easy to forget: the day one of them interpolates an upstream's reply, the
 * redactor would otherwise be guarding half a line.
 */

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** Returns a logger that stamps `fields` onto every line — how `requestId` propagates. */
  child(fields: LogFields): Logger
}

export interface LoggerOptions {
  readonly level: LogLevel
  /** Sink for a finished line, newline excluded. Injected so tests capture instead of print. */
  readonly write?: (line: string) => void
  readonly now?: () => Date
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const now = options.now ?? (() => new Date())
  const threshold = LEVEL_ORDER[options.level]

  const emit = (level: LogLevel, bound: LogFields, msg: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < threshold) return
    const payload = {
      ts: now().toISOString(),
      level,
      msg: redactValue(msg),
      ...redact({ ...bound, ...fields }),
    }
    write(JSON.stringify(payload))
  }

  const build = (bound: LogFields): Logger => ({
    debug: (msg, fields) => emit("debug", bound, msg, fields),
    info: (msg, fields) => emit("info", bound, msg, fields),
    warn: (msg, fields) => emit("warn", bound, msg, fields),
    error: (msg, fields) => emit("error", bound, msg, fields),
    child: (fields) => build({ ...bound, ...fields }),
  })

  return build({})
}
