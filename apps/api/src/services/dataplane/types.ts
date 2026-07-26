import type { Dialect, UsageOutcome } from "@multi-ai-router/core"
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

/**
 * What a data-plane request asks an Account to *do*, as distinct from which dialect it speaks.
 *
 * `messages` is inference — three of the five POST paths. The other two ask for something that is
 * not a completion at all, which is why the operation travels beside the dialect instead of being
 * derived from it:
 *
 *  - `count-tokens` is Anthropic's `POST /v1/messages/count_tokens`, which Claude Code calls before
 *    a turn to decide when to compact — same body shape, a different endpoint below the base URL,
 *    and an answer that is a measurement rather than a completion;
 *  - `embeddings` is OpenAI's `POST /v1/embeddings`, which every RAG toolchain calls beside its
 *    chat traffic — a body that names no chat surface, and an answer that spends input tokens and
 *    produces no output ones.
 *
 * Fixed per route like the dialect is, and for the same reason — the path is the contract.
 */
export type UpstreamOperation = "messages" | "count-tokens" | "embeddings"

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

/**
 * One finished client request, as the router observed it.
 *
 * Reported here because no `UsageRecord` can carry it: a request that failed over writes several
 * attempt rows, and none of them says which attempt the client's answer came from. Everything
 * that *is* per-attempt stays on the record and is counted off the request path.
 */
export interface RequestSample {
  readonly ingressDialect: Dialect
  /** What the body named, never substituted. Null when it named nothing at all. */
  readonly model: string | null
  readonly keyId: string
  readonly outcome: UsageOutcome
  /**
   * Router-observed time until the response was handed back. A streamed body drains *after* that
   * point, so a streamed sample measures time-to-response and not time-to-last-token — which is
   * why `streamed` travels with it, and why the two populations are never averaged together.
   */
  readonly durationMs: number
  readonly streamed: boolean
}

/** Notified once per client request. Must not throw; it is never awaited. */
export type RequestObserver = (sample: RequestSample) => void

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
