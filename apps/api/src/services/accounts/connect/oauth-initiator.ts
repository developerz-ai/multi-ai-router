import { AUDIT_ACTOR_KINDS, type OauthStateInitiator } from "@multi-ai-router/db"
import { z } from "zod"
import { currentAuditContext, runWithAuditContext } from "../../admin/audit-context"

/**
 * Who started an account connect, carried from the guarded start to wherever it completes
 * (multi-ai-router#455, docs/idea/08-observability.md#audit-events).
 *
 * A connect completes on a request that is not the start's: the provider's redirect lands on the
 * unguarded callback with no session at all, and a device-code attempt is finished by whichever
 * console tab or script polls it next. So the start stores its caller on the `oauth_states` row,
 * and the completing write — `account.connected` / `account.reauthorized` — runs under that
 * caller. The stored starter wins over a live caller on the completing request: the row answers
 * "who connected this account", and that is whoever began it.
 */

/** The caller to store on the attempt being minted; null where the start ran with none. */
export function connectInitiator(): OauthStateInitiator | null {
  return currentAuditContext() ?? null
}

/** The jsonb comes back from the database, so it is parsed, never cast. */
const InitiatorSchema = z.object({
  actor: z.string().min(1),
  actorKind: z.enum(AUDIT_ACTOR_KINDS),
  says: z.string().nullable(),
  clientIp: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
})

/**
 * Runs `fn` as the attempt's starter. A row with no starter — minted before migration 0050, or one
 * that does not parse — leaves the current context alone: the completing request's own caller
 * where it has one, else the recorder's `unattributed` path, which reports itself.
 */
export function asConnectInitiator<T>(stored: unknown, fn: () => T): T {
  const parsed = InitiatorSchema.safeParse(stored)
  return parsed.success ? runWithAuditContext(parsed.data, fn) : fn()
}
