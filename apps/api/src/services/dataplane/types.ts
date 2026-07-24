import type { Dialect } from "@multi-ai-router/core"
import type { DriverAccount } from "../../providers"
import type { AccountSnapshot, PoolSnapshot } from "../routing"

/**
 * What the data plane needs to know about the world, and where it gets it.
 *
 * Both are read from **warm memory** on every request: nothing here may touch Postgres on the
 * critical path (docs/idea/01-architecture.md, performance budget). Keeping the catalog warm — and
 * invalidating it when the admin plane changes an account, a pool, or a membership — belongs to
 * the layer that owns those writes, which is why this is an interface and not a loader.
 */

/**
 * One account, in the three views the request path needs: what routing ranks, what the driver
 * addresses, and the credential envelope the driver's headers are built from.
 *
 * The envelope is **ciphertext** here and is decrypted inside the attempt, on the outbound request
 * and nowhere else — upstream credentials cross exactly one boundary.
 */
export interface RoutableAccount {
  readonly id: string
  /** The routing view. `status` and `health` are overlaid from the health store per request. */
  readonly snapshot: AccountSnapshot
  /** The provider view: base URL override, chosen surface, alias map. Never the credential. */
  readonly driver: DriverAccount
  /** AES-256-GCM envelope. Null for Claude subscription accounts, which hold a config dir. */
  readonly authMaterial: string | null
  /** Claude subscription accounts only: the isolated `CLAUDE_CONFIG_DIR`. */
  readonly configDir: string | null
}

export interface RoutingCatalog {
  /** Every account the router knows about, disabled ones included — filtering is routing's job. */
  accounts(): readonly RoutableAccount[]
  pools(): readonly PoolSnapshot[]
}

/** The upstream call, injected so a test needs no network and no live provider. */
export type FetchLike = (request: Request) => Promise<Response>

/** The ingress dialect a data-plane route speaks. Fixed per path, never sniffed from a body. */
export type IngressDialect = Dialect

export interface DataPlaneClock {
  /** Wall clock, for timestamps and for every routing decision that reads `now`. */
  readonly now: () => Date
  /** Monotonic milliseconds, for durations. Wall time can move; a latency measurement may not. */
  readonly elapsed: () => number
}

export const SYSTEM_CLOCK: DataPlaneClock = {
  now: () => new Date(),
  elapsed: () => performance.now(),
}

/** Convenience for building a catalog entry's routing view without restating the defaults. */
export function routingView(
  account: Pick<AccountSnapshot, "id" | "label" | "provider">,
  overrides: Partial<AccountSnapshot> = {},
): AccountSnapshot {
  return {
    status: "active",
    weight: 100,
    priority: 0,
    health: { consecutiveFailures: 0, inFlight: 0, recentTokens: 0 },
    ...account,
    ...overrides,
  }
}
