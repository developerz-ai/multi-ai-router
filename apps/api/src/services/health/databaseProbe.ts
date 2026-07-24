import type { DatabaseHandle } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"

/**
 * The readiness check against PostgreSQL: one `select 1` on the pool the router already holds,
 * bounded by a timeout so a wedged database cannot hang `/readyz`.
 *
 * It borrows the handle rather than dialing its own connection — the pool is warm, and nothing
 * here may open a socket per probe. Lifecycle stays with `main.ts`, which owns the handle.
 */

const DEFAULT_TIMEOUT_MS = 2_000

export interface DatabaseProbeOptions {
  /** The connection from `createDatabase`. Only the raw `sql` tag is needed. */
  readonly handle: Pick<DatabaseHandle, "sql">
  readonly log: Logger
  readonly timeoutMs?: number
}

export function createDatabaseProbe(options: DatabaseProbeOptions): () => Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return async (): Promise<boolean> => {
    try {
      await withTimeout(options.handle.sql`select 1`, timeoutMs)
      return true
    } catch (error) {
      // The connection string carries a password, so only the failure class is logged.
      options.log.warn("database probe failed", {
        component: "transport",
        errorClass: error instanceof Error ? error.name : "unknown",
      })
      return false
    }
  }
}

async function withTimeout<T>(work: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("database probe timed out")), timeoutMs)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}
