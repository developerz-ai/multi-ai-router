import type { ClientFrame } from "./envelope"

/**
 * The non-streaming body, folded from the **same** frames the streaming one writes.
 *
 * `query()` is launched with `includePartialMessages: true` unconditionally (`options.ts`), so
 * there is one event stream and this is a second rendering of it rather than a second renderer.
 * That is the point: a client that asks for `stream: false` must get exactly the message a
 * streaming client would have assembled, down to where each block began. Two independent readers of
 * the SDK's output would eventually disagree about that, and the disagreement would be invisible
 * until a user compared the two.
 *
 * It buffers, and buffering here is not the thing the streaming rules forbid: the client asked for
 * one JSON object and no byte is delayed that could have gone out earlier
 * (`services/dataplane/relay-translate.ts` makes the same call for the same reason).
 *
 * Nothing is invented. A block whose arguments never parsed keeps whatever the SDK stated at its
 * start rather than an empty object; a turn that produced nothing yields `content: []`.
 */

/** The accumulated `input_json_delta` text for a block, before it is parsed at `content_block_stop`. */
interface PendingBlock {
  readonly block: Record<string, unknown>
  json: string
}

export interface MessageFold {
  push(frames: readonly ClientFrame[]): void
  /** The Anthropic Messages body. An `error` frame yields the error object itself. */
  body(): Record<string, unknown>
  /** Whether the turn ended in an `error` frame, so the caller does not answer `200` to one. */
  failed(): boolean
}

export function createMessageFold(): MessageFold {
  let message: Record<string, unknown> | null = null
  let error: Record<string, unknown> | null = null
  const blocks = new Map<number, PendingBlock>()
  let order: number[] = []

  const apply = (frame: ClientFrame): void => {
    switch (frame.type) {
      case "message_start":
        message = isRecord(frame.message) ? { ...frame.message } : {}
        break

      case "content_block_start": {
        const index = indexOf(frame)
        if (index === null) break
        const block = isRecord(frame.content_block) ? { ...frame.content_block } : {}
        blocks.set(index, { block, json: "" })
        order = [...order.filter((at) => at !== index), index]
        break
      }

      case "content_block_delta": {
        const index = indexOf(frame)
        const pending = index === null ? undefined : blocks.get(index)
        if (pending === undefined || !isRecord(frame.delta)) break
        applyDelta(pending, frame.delta)
        break
      }

      case "content_block_stop": {
        const index = indexOf(frame)
        const pending = index === null ? undefined : blocks.get(index)
        if (pending === undefined || pending.json.length === 0) break
        const parsed = parseJson(pending.json)
        // Unparseable arguments keep the block's stated input: a truncated tool call is a real
        // outcome, and replacing it with `{}` would report a call the model never completed as one
        // it made with no arguments.
        if (parsed !== null) pending.block.input = parsed
        break
      }

      case "message_delta": {
        if (message === null) break
        if (isRecord(frame.delta)) Object.assign(message, frame.delta)
        if (isRecord(frame.usage)) {
          message.usage = { ...(isRecord(message.usage) ? message.usage : {}), ...frame.usage }
        }
        break
      }

      case "error":
        error = isRecord(frame.error) ? { type: "error", error: frame.error } : { ...frame }
        break

      default:
        break
    }
  }

  return {
    push(frames) {
      for (const frame of frames) apply(frame)
    },

    failed() {
      return error !== null
    },

    body() {
      if (error !== null) return error
      const base = message ?? {}
      const content: unknown[] = []
      for (const index of order) {
        const pending = blocks.get(index)
        if (pending !== undefined) content.push(pending.block)
      }
      return { ...base, content }
    },
  }
}

function applyDelta(pending: PendingBlock, delta: Record<string, unknown>): void {
  switch (delta.type) {
    case "text_delta":
      if (typeof delta.text === "string") pending.block.text = text(pending.block.text) + delta.text
      break
    case "thinking_delta":
      if (typeof delta.thinking === "string") {
        pending.block.thinking = text(pending.block.thinking) + delta.thinking
      }
      break
    case "signature_delta":
      if (typeof delta.signature === "string") pending.block.signature = delta.signature
      break
    case "input_json_delta":
      if (typeof delta.partial_json === "string") pending.json += delta.partial_json
      break
    default:
      // A delta kind this build does not define carries content it cannot place. Dropped rather
      // than guessed at — the streaming half forwards it, so the two shapes differ only here, and
      // §6 already records that unknown upstream features do not survive re-synthesis.
      break
  }
}

function indexOf(frame: ClientFrame): number | null {
  return typeof frame.index === "number" && Number.isInteger(frame.index) ? frame.index : null
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
