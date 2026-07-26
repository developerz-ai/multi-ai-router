/**
 * The tool calls an upstream started while another one's block was still open.
 *
 * Anthropic and openai-responses both hold **one open block at a time**, and neither has an event
 * that reopens a closed one. openai-chat has no such rule: `delta.tool_calls[]` is keyed by an index
 * the upstream is free to revisit, so a chunk carrying `[{index:0},{index:1}]` followed by more
 * arguments for index 0 is well-formed there and unrepresentable here — and vLLM, SGLang, Fireworks
 * and Together all emit exactly that shape for parallel calls.
 *
 * A reader that keeps only the block it opened last answers such a stream with a `tool_use` whose
 * `input` is truncated and a `stop_reason` saying the call was complete. The client cannot tell, and
 * runs the tool with the wrong arguments. So the fragments that have nowhere to go are held here and
 * replayed into a block of their own the moment the live one closes.
 *
 * **This is not stream buffering** (`docs/idea/06-protocol-translation.md#streaming-sse-event-mapping`).
 * Nothing that has a block to go to waits: text is never touched, and the live call's deltas leave as
 * they arrive. What is held is the remainder the dialect's own boundary rules will not let out yet,
 * bounded by the arguments of the calls after the first — the same order of state
 * `shared/responses-stream.ts` already keeps to restate its finished text.
 *
 * Order is first-sighting order, which is the order the upstream introduced the calls in.
 */

export interface PendingToolCall {
  readonly key: string | number
  readonly id: string | null
  readonly name: string | null
  /** Every fragment sighted while the call had no block, concatenated in arrival order. */
  readonly args: string
}

export interface PendingToolCalls {
  has(key: string | number): boolean
  /**
   * Records a call with whatever the upstream has stated so far, or fills in an id or name a later
   * sighting states for one already recorded — openai-chat is free to split them across deltas.
   */
  add(
    key: string | number,
    call: { readonly id?: string | null | undefined; readonly name?: string | null | undefined },
  ): void
  /** Appends a fragment to a recorded call. `false` when nothing has that key. */
  append(key: string | number, partialJson: string): boolean
  /** Empties the queue, in first-sighting order. */
  drain(): PendingToolCall[]
}

interface Entry {
  id: string | null
  name: string | null
  args: string
}

/** An empty string is a field the upstream sent without filling in, not a stated value. */
function stated(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.length === 0 ? null : value
}

export function createPendingToolCalls(): PendingToolCalls {
  // A Map, because insertion order *is* the answer `drain` owes and a plain object would reorder
  // integer-like keys.
  const entries = new Map<string | number, Entry>()

  return {
    has: (key) => entries.has(key),

    add(key, call) {
      const entry = entries.get(key)
      if (entry === undefined) {
        entries.set(key, { id: stated(call.id), name: stated(call.name), args: "" })
        return
      }
      entry.id = entry.id ?? stated(call.id)
      entry.name = entry.name ?? stated(call.name)
    },

    append(key, partialJson) {
      const entry = entries.get(key)
      if (entry === undefined) return false
      entry.args += partialJson
      return true
    },

    drain() {
      const drained = [...entries].map(([key, entry]) => ({ key, ...entry }))
      entries.clear()
      return drained
    },
  }
}
