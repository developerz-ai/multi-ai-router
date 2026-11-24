import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk"
import type { ToolRewriter } from "./rewrite"

/** What the early stop captures and reports, apart from the race that decides it (`early-stop.ts`). */

/** A tool call the model asked the SDK to run, as the `PreToolUse` hook saw it. */
export interface CapturedToolCall {
  readonly id: string
  /** The **client's** name, already un-prefixed. */
  readonly name: string
  /** The complete arguments — the hook sees them assembled, unlike the stream. */
  readonly input: unknown
}

/**
 * What the turn's tool handling got wrong, if anything. Both fields are silent-bug detectors: a
 * client cannot tell a dropped call from a model that never made one, and neither can a log line.
 */
export interface ToolIntegrity {
  readonly emitted: number
  readonly captured: number
  /** Block ids the client was sent that no hook ever saw — a call the SDK never dispatched. */
  readonly uncaptured: readonly string[]
  /** Block ids whose arguments arrived empty though the tool declares required ones. */
  readonly emptyInput: readonly string[]
  /**
   * Tool blocks the flush had to close because the loop ended before their `content_block_stop`.
   *
   * Zero in an ordinary turn. It is the fact that separates the two remaining readings of a turn
   * that ends with a `tool_use` block still open at the renderer: **non-zero** says the rewriter
   * held that block and closed it, so anything still open is a block the rewriter never saw;
   * **zero** says the rewriter was holding nothing, so the block the renderer had open was never
   * the rewriter's to close and the discrepancy is between the envelope and the stream, not here.
   *
   * Read only when a turn truncates, and it exists because three plausible reproductions of that
   * shape all close correctly (`tool-gate.test.ts`) — so the log line has to say which of them
   * production is not.
   */
  readonly flushedBlocks: number
}

export interface EarlyStopInput {
  readonly rewriter: ToolRewriter
  /** Terminates the subprocess. Called at most once, and only for an early stop. */
  readonly abort?: () => void
  readonly holdTimeoutSeconds?: number
}

export interface EarlyStop {
  /** Merge into `Options.hooks`. Unmatched, so it sees every tool call the SDK dispatches. */
  readonly hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>
  /**
   * Wraps the SDK's message stream. The renderer reads the wrapper, so suppression and rewriting
   * happen before re-synthesis rather than inside it — one agent loop, two modules, no shared state.
   */
  filter(messages: AsyncIterable<unknown>): AsyncIterable<unknown>
  readonly captures: readonly CapturedToolCall[]
  integrity(): ToolIntegrity
}
