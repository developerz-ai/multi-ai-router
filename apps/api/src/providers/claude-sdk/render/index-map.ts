import type { WireEvent } from "./events"

/**
 * Content-block indices are **ours**, not the SDK's.
 *
 * The SDK runs an agent loop, and every internal turn starts its own message: turn one numbers its
 * blocks `0, 1`, turn two starts again at `0`. The client is owed **one** message whose blocks are
 * numbered once, monotonically, from zero — so the two numberings are different spaces and a map
 * between them is not an optimization, it is the contract
 * (docs/idea/11-anthropic-agent-sdk.md §6, `server.ts:2516`). Forwarding the SDK's numbers directly
 * makes turn two's first block overwrite turn one's, and a client that assembles by index loses
 * everything the model said before it called a tool.
 *
 * **A filtered block must lose its whole triple.** `content_block_start`, every
 * `content_block_delta`, and `content_block_stop` all carry the same index; dropping only the start
 * leaves deltas addressed to a block the client never opened, which is worse than either forwarding
 * or dropping all three. So the keep/drop decision is made **once**, at the start, and remembered
 * until the stop — this module is where it is remembered, so no caller can make it twice and
 * disagree with itself.
 *
 * **And the SDK's index is only unique within its own turn.** A subagent numbers its blocks from
 * zero exactly as the main turn does, and the two interleave: a map keyed on the index alone lets a
 * dropped subagent block evict the mapping of the answer's own block 0, after which the rest of the
 * real answer is silently discarded. So every lookup is keyed on `(turn, index)`, where the turn is
 * the SDK's `parent_tool_use_id` — null for the turn the client actually asked for.
 *
 * Pure: no clock, no I/O, no allocation policy beyond a counter (non-negotiable 9).
 */

/** Forward this event under `index`, or drop it entirely. */
export type BlockDecision =
  | { readonly kind: "forward"; readonly index: number }
  | { readonly kind: "drop" }

const DROP: BlockDecision = { kind: "drop" }

/** Which SDK turn a block belongs to: `parent_tool_use_id`, or null for the client's own turn. */
export type Turn = string | null

export interface BlockIndexMap {
  /**
   * A `content_block_start` arrived for `sdkIndex` in `turn`.
   *
   * Allocates the next client index when `keep`, and records the decision either way. Always
   * allocates on a keep, never reuses: an index seen twice in one turn is two different blocks from
   * two different internal iterations, and giving the second one the first one's number is the
   * corruption this map exists to prevent.
   */
  start(turn: Turn, sdkIndex: number, keep: boolean): BlockDecision
  /**
   * A `content_block_delta` arrived.
   *
   * Drops anything with no open mapping — a filtered block, or a delta for a block whose start
   * never arrived. A client is never handed an index it has not seen opened.
   */
  block(turn: Turn, sdkIndex: number): BlockDecision
  /** A `content_block_stop` arrived: resolve it, then forget the mapping. */
  stop(turn: Turn, sdkIndex: number): BlockDecision
  /** Client indices still open, in the order they were opened. Terminating closes each one. */
  open(): readonly number[]
  /** How many client indices have been handed out. Diagnostics and tests; nothing routes on it. */
  readonly allocated: number
}

/**
 * A `Map`, not an object literal: the turn half of the key is an id the SDK chose, and an object
 * used as a lookup would resolve `"constructor"` through its prototype and hand back a function.
 *
 * Length-prefixed rather than separator-joined, so no id containing the separator can be made to
 * collide with another turn's block.
 */
function keyOf(turn: Turn, sdkIndex: number): string {
  const id = turn ?? ""
  return `${id.length}:${id}:${sdkIndex}`
}

export function createBlockIndexMap(): BlockIndexMap {
  /** `(turn, index)` → client index. Absent means "filtered, or never started". */
  const mapping = new Map<string, number>()
  /** Client indices in open order, so a terminating stream closes them the way it opened them. */
  const openOrder: number[] = []
  let next = 0

  const forget = (key: string): void => {
    const client = mapping.get(key)
    if (client === undefined) return
    mapping.delete(key)
    const at = openOrder.indexOf(client)
    if (at !== -1) openOrder.splice(at, 1)
  }

  return {
    start(turn, sdkIndex, keep) {
      const key = keyOf(turn, sdkIndex)
      // A start for an index already open in this turn is an iteration boundary the SDK did not
      // close cleanly. The stale mapping goes: the new block is a different block.
      forget(key)
      if (!keep) return DROP
      const client = next
      next += 1
      mapping.set(key, client)
      openOrder.push(client)
      return { kind: "forward", index: client }
    },

    block(turn, sdkIndex) {
      const client = mapping.get(keyOf(turn, sdkIndex))
      return client === undefined ? DROP : { kind: "forward", index: client }
    },

    stop(turn, sdkIndex) {
      const key = keyOf(turn, sdkIndex)
      const client = mapping.get(key)
      if (client === undefined) return DROP
      forget(key)
      return { kind: "forward", index: client }
    },

    open() {
      return [...openOrder]
    },

    get allocated() {
      return next
    },
  }
}

/**
 * The forwarded event, with the SDK's index replaced by ours.
 *
 * A shallow copy rather than a mutation: the event object belongs to the SDK's message, which the
 * quota and session readers also see, and rewriting a field in place would make what those readers
 * observe depend on whether the renderer ran first. Everything else the upstream stated — deltas,
 * block bodies, fields this build has never heard of — survives exactly as it arrived; the index is
 * the one field that was never the SDK's to decide.
 */
export function withClientIndex(
  event: WireEvent,
  index: number,
): Record<string, unknown> & { type: string } {
  return { ...event.raw, type: event.type, index }
}
