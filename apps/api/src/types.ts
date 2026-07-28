import type { Logger } from "./logging/logger"
import type {
  AccountsService,
  ConnectService,
  DiscoverModelsService,
  RecheckService,
  TestNowService,
} from "./services/accounts"
import type { AdminAuthService } from "./services/admin-auth"
import type { AccountAuthProbe } from "./services/health/claudeAuthProbe"
import type { KeysService } from "./services/keys"
import type { PoolsService } from "./services/pools"
import type { SettingsService } from "./services/settings"
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
  /**
   * One field for three route groups: configuration, scheduled-task health and the audit feed are
   * one screen and one service — see `services/settings/service.ts`.
   */
  readonly settings: SettingsService
  /** The "Re-check now" button's server side, per account and for all of them. */
  readonly recheck: RecheckService
  /**
   * The "Test now" button's server side: one real, opt-in completion against one account, distinct
   * from `recheck` because it actually spends a request (`services/accounts/test-now.ts`).
   */
  readonly testNow: TestNowService
  /**
   * "Is this Claude subscription still logged in", asked of the CLI's own credential file — free,
   * contacts no provider, and owns the `needs_reauth` transition
   * (`services/health/claudeAuthProbe.ts`).
   *
   * Exposed because the keepalive sweep must ask it *before* spending a turn: a credential that is
   * already dead fails the test for a reason only a human can fix, so billing one to re-learn that
   * is a slow leak. Absent when no `claude` CLI is available to answer.
   */
  readonly authProbe?: AccountAuthProbe
  /**
   * "Discover models": reads the upstream's own listing into `supportedModels`. The one button of
   * the three that changes the row, which is why it writes through `accounts` rather than beside it
   * (`services/accounts/discover-models.ts`).
   */
  readonly discoverModels: DiscoverModelsService
  /** Connect and reconnect, both flows: the `claude` CLI's login, and the router's own PKCE one. */
  readonly connect: ConnectService
}
