import type { Logger } from "./logging/logger"
import type { AccountsService, ClaudeConnectService, RecheckService } from "./services/accounts"
import type { AdminAuthService } from "./services/admin-auth"
import type { KeysService } from "./services/keys"
import type { PoolsService } from "./services/pools"
import type { UsageService } from "./services/usage-read"

/**
 * The Hono environment every route and middleware in the transport layer shares. Transport is
 * the only layer that knows Hono exists (docs/idea/01-architecture.md, dependency rule 5), so
 * this type never leaves it.
 */
export interface AppEnv {
  Variables: {
    /** Correlation id assigned at ingress and propagated end to end. */
    requestId: string
    /** Request-scoped logger, pre-bound with `requestId` and `component`. */
    log: Logger
  }
}

/**
 * Everything the admin plane is mounted against.
 *
 * The CRUD services arrive already wrapped in the cache-coherence decorators
 * from `services/admin/coherence.ts`, so a mutation reaching this bundle has
 * already taken effect on the request path. `recheck` is the one remaining reach
 * *into* the data plane, and it is the complete list: the console can clear an
 * account's breaker marks, and it can do nothing else to a live request.
 */
export interface AdminServices {
  readonly auth: AdminAuthService
  readonly accounts: AccountsService
  readonly pools: PoolsService
  readonly keys: KeysService
  readonly usage: UsageService
  /** The "Re-check now" button's server side, per account and for all of them. */
  readonly recheck: RecheckService
  /** Connect and reconnect for Claude subscriptions: the `claude` CLI's login, driven server-side. */
  readonly connect: ClaudeConnectService
}
