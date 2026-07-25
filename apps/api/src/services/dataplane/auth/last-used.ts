import type { ApiKeyRepository } from "@multi-ai-router/db"
import type { Logger } from "../../../logging/logger"

/**
 * Stamping a router key's `lastUsedAt` — fired, never awaited.
 *
 * It is reporting: the console shows an operator which keys are still in use so a stale one can be
 * revoked. Awaiting it would put a write on the request path for a column nothing routes on, which
 * the performance budget forbids outright (docs/idea/01-architecture.md).
 *
 * The failure is swallowed into a log line for the same reason. A key that verified is a key that
 * may proceed; an `UPDATE` that lost a race, hit a saturated pool, or arrived during a failover has
 * no bearing on that, and turning it into a `500` would fail requests over a timestamp.
 */
export function stampLastUsed(
  keys: Pick<ApiKeyRepository, "touchLastUsed">,
  logger: Logger,
  now: () => Date,
): (key: { readonly id: string }) => void {
  return (key) => {
    void keys.touchLastUsed(key.id, now()).catch((error: unknown) => {
      logger.warn("failed to stamp key last-used", {
        component: "dataplane",
        keyId: key.id,
        reason: error instanceof Error ? error.message : String(error),
      })
    })
  }
}
