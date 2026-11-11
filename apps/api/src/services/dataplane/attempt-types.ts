import type { Dialect } from "@multi-ai-router/core"
import type { ProviderDriver } from "../../providers"
import type { UpstreamStartGuard } from "../../providers/upstream-admission"
import type { CredentialCipher } from "../crypto/cipher"
import type { FetchLike, RoutableAccount } from "./types"
import type { StreamDeadlines } from "./upstream-deadline"

/** What one upstream attempt is given (`attempt.ts`). */
export interface AttemptPlan {
  readonly account: RoutableAccount
  readonly driver: ProviderDriver
  readonly dialect: Dialect
  readonly url: URL
  /** The model this account expects, after its alias map. */
  readonly upstreamModel: string
}

export interface AttemptInput {
  readonly plan: AttemptPlan
  readonly method: string
  /** The client's headers, verbatim. Stripping and credential injection happen here. */
  readonly clientHeaders: Headers
  /** The opaque body. Forwarded byte for byte. */
  readonly body: Uint8Array | null
  readonly fetch: FetchLike
  readonly cipher: Pick<CredentialCipher, "decrypt">
  readonly timeoutMs: number
  /**
   * Present when the upstream answers as a stream: first-byte, idle and total clocks replace the one
   * `timeoutMs` deadline (`upstream-deadline.ts`). Absent keeps `timeoutMs` for the whole attempt.
   */
  readonly stream?: StreamDeadlines
  readonly errorMaxBytes?: number
  readonly beforeUpstreamStart?: UpstreamStartGuard
  readonly onUpstreamStarted?: () => void
  /** The client's own abort signal, so a client that goes away releases the upstream call. */
  readonly signal?: AbortSignal
  /**
   * The router abandoning the request (shutdown). Ends only the success peek: the upstream call
   * itself is left to its own clocks, and the chain answers the shutdown.
   */
  readonly abandon?: AbortSignal
  /**
   * The client asked to stream: its peek is bounded by `stream.wallHoldMs` and then commits
   * (`success-wall.ts`). A client that is not streaming is peeked until the first event decides.
   */
  readonly clientStreams?: boolean
  /**
   * Replaces the client's `Accept`. Set only for a body the router rewrote to stream for a surface
   * that answers only as SSE: the client's own value describes the response *it* is owed, not the
   * one the router asked the upstream for.
   */
  readonly accept?: string
  /**
   * The surface's prompt-cache affinity header and its value (`egress/cache-key-header.ts`). Never
   * overrides a driver header: only the selected account's driver speaks for the account.
   */
  readonly cacheKey?: readonly [string, string]
  /** For a surface that requires one (`ProviderDriver.sessionHeader`). Absent: a one-off id, as a
   * model listing or an account test is no conversation and that surface refuses none at all. */
  readonly conversationId?: string
}

/** What the upstream said, when it said something the client should see. */
export interface UpstreamError {
  readonly status: number
  readonly headers: Headers
  readonly bodyText: string
  readonly contentType: string | null
}
