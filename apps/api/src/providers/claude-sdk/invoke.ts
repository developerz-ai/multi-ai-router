import type { TruncatedTurn } from "./render"
import type { SessionPlan } from "./session"

/**
 * The I/O half of the Claude subscription transport: one `query()` call, one answer.
 *
 * This is the SDK path's `FetchLike`. It exists as a type before it exists as an implementation for
 * the same reason `fetch` is injected on the HTTP path — the data plane must be dispatchable without
 * a subprocess, and `bin/test` may never spawn a real `claude` CLI
 * (docs/idea/11-anthropic-agent-sdk.md §9, CLAUDE.md testing rules).
 *
 * The contract is deliberately narrow, and the narrowness is what keeps the rest of the data plane
 * from knowing an SDK exists:
 *
 * - **In:** an Anthropic Messages request body. The client's own dialect was already converted, by
 *   the same translator an `anthropic-api` account would have used.
 * - **Out:** a `Response` whose body is Anthropic Messages — re-synthesized, never relayed
 *   (§6: even `POST /v1/messages` against a subscription is a re-synthesis). Downstream, that is
 *   indistinguishable from an upstream's own answer, so the relay, the token observer, and the
 *   `UsageRecord` are written once for both transports.
 * - **Abort:** one signal, already composed from the client's disconnect and the attempt deadline.
 *   Aborting terminates the subprocess; a client that goes away must never orphan one (§9).
 * - **Session:** a resolved lineage plan in, the SDK's own session id back out. Deciding *whether*
 *   to resume is a pure function over stored hashes (`session/lineage.ts`); this seam only carries
 *   the answer to `query()` and reports what the subprocess named itself (§4).
 */
export interface SdkInvocation {
  /** Which Account this runs as. Rate-limit state and session lineage are keyed by it, never global. */
  readonly accountId: string
  /** The isolated `CLAUDE_CONFIG_DIR`. Already resolved, never empty. */
  readonly configDir: string
  /** The model after the Account's alias map. Passed through, never substituted. */
  readonly model: string
  /** Anthropic Messages request bytes. Null only when the client sent no body at all. */
  readonly body: Uint8Array | null
  readonly signal: AbortSignal
  /**
   * `resume`, `forkSession` + `resumeSessionAt`, or nothing — already decided. A launch must apply
   * it verbatim: re-deriving it here would put the same correctness decision in two places, and
   * `fresh` is a decision, not the absence of one.
   */
  readonly session: SessionPlan
  /**
   * Called once the SDK names its session, which it does in `system`/`init` before any content.
   * The binding is only worth persisting from here: an Account with no session id to resume is a
   * pin with no payoff, and pinning one would cost the failover a cooling-down Account still has.
   */
  readonly onSession?: (report: SdkSessionReport) => void
  /**
   * Called for every `rate_limit_event` the SDK reports, forwarding the raw `rate_limit_info`
   * payload unread — folding it into Account quota state is `quota.ts`'s vocabulary, not this
   * seam's. Optional for the same reason `onSession` is: a launch that never wires quota still
   * answers, just without cooling the account down ahead of the next `429`.
   */
  readonly onRateLimit?: (info: unknown) => void
  /**
   * Called at most once per turn, when it ended with content blocks still open — the turn stopped
   * mid-answer, and the renderer answered with an error rather than a completion. The detail is
   * what the renderer knew at that moment, plus the two facts only the invoker holds; the render
   * layer is pure and holds no logger, so a launch that wires nothing simply goes unalarmed.
   */
  readonly onTruncatedTurn?: (detail: SdkTruncatedTurn) => void
}

/**
 * The renderer's account of a truncated turn, plus what the *launch* knew about its tool surface.
 *
 * Those last two are here because the open block's kind alone cannot settle the question the live
 * data raises. Turns are ending on a `tool_use` block that never closes, and the two explanations
 * have opposite fixes: a client that **declared tools** has a passthrough, so `ToolRewriter.flush`
 * should already have closed that block and something upstream of it is wrong; a client that
 * declared **none** has no passthrough and no flush at all — and a `tool_use` block appearing at all
 * in that case would mean the built-in catalog `options.ts` elides with `tools: []` was not fully
 * elided, which is a different bug in a different file.
 *
 * One field each, and the next occurrence says which. Measuring that from outside would mean
 * correlating the alarm against the request body, which is the thing this router parses exactly once
 * and never logs.
 */
export interface SdkTruncatedTurn extends TruncatedTurn {
  /** How many tools the client declared. Zero means no passthrough was built, and no flush ran. */
  readonly declaredTools: number
  /** Whether a passthrough exists — the machinery that closes a held tool block when a loop ends. */
  readonly passthrough: boolean
  /**
   * Tool blocks that machinery actually closed on its way out (`ToolIntegrity.flushedBlocks`).
   *
   * With `passthrough: true` and a `tool_use` block still open, this is the field that says which
   * way to look: non-zero means the rewriter held a block and closed it, so whatever the renderer
   * still had open was never the rewriter's; zero means the rewriter was holding nothing at all.
   */
  readonly flushedBlocks: number
}

export interface SdkSessionReport {
  readonly sdkSessionId: string
  /**
   * The SDK assistant message this turn produced, when the SDK named one. It is what a later undo
   * rewinds to; without it an undo starts a fresh session rather than forking at the right point.
   */
  readonly assistantUuid?: string
}

export type SdkInvoker = (invocation: SdkInvocation) => Promise<Response>
