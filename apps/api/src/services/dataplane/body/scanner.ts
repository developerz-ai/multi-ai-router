/**
 * An incremental byte scanner over a JSON request body.
 *
 * **The passthrough body is opaque.** On same-dialect egress the router extracts exactly two
 * things from it — the model name and the session key — and forwards the rest untouched. Doing
 * that with `JSON.parse` would materialize an entire conversation (megabytes of transcript, base64
 * images, tool schemas) to read two fields, on every request, in the hot path of every developer
 * and every agent. So this reads bytes as they arrive and stops as soon as it has what it needs
 * (docs/idea/06-protocol-translation.md#performance-rules).
 *
 * It is a scanner, not a parser: it tracks string boundaries, escapes, and nesting depth, and
 * knows nothing about the schema beyond two top-level key names. Malformed input yields no
 * captures rather than an exception — the body is the upstream's to reject, not ours.
 *
 * Two captures:
 *
 * - **`model`**, top-level, with the byte span of its value. The span is what lets an Account's
 *   alias map rewrite the name without re-serializing the body.
 * - **A bounded prefix of the messages array**, the fingerprint input. A conversation grows by
 *   appending, so its first message stays byte-identical turn after turn: hashing that prefix is
 *   stable across the turns of one conversation and distinct between two
 *   (docs/idea/05-routing-and-failover.md, "The session key").
 */

const QUOTE = 0x22
const BACKSLASH = 0x5c
const COLON = 0x3a
const COMMA = 0x2c
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d

/** Top-level keys whose value is the conversation. First match wins; `messages` is Anthropic and
 * OpenAI Chat, `input` is OpenAI Responses. */
const CONVERSATION_KEYS = new Set(["messages", "input"])

const MODEL_KEY = "model"

export interface ByteSpan {
  /** Offset of the first byte of the string's contents — the quote is excluded. */
  readonly start: number
  /** Offset one past the last byte of the contents. */
  readonly end: number
}

export interface ScanResult {
  readonly model: string | null
  readonly modelSpan: ByteSpan | null
  /** Bounded prefix of the conversation value, verbatim. Empty when none was found. */
  readonly conversationPrefix: Uint8Array
}

export interface ScannerOptions {
  /** How many bytes of the conversation to keep. Bigger is a stabler fingerprint and more work. */
  readonly conversationPrefixBytes?: number
}

export const DEFAULT_CONVERSATION_PREFIX_BYTES = 1_024

export interface RoutingScanner {
  /** Feeds one chunk. Cheap once {@link RoutingScanner.done} is true. */
  push(chunk: Uint8Array): void
  /** True when nothing further can be learned — the caller may stop scanning entirely. */
  readonly done: boolean
  result(): ScanResult
}

export function createRoutingScanner(options: ScannerOptions = {}): RoutingScanner {
  const prefixLimit = options.conversationPrefixBytes ?? DEFAULT_CONVERSATION_PREFIX_BYTES
  const decoder = new TextDecoder("utf-8")

  let offset = 0
  let depth = 0
  let inString = false
  let escaped = false
  /** Absolute offset of the current string's first content byte. */
  let stringStart = -1
  /** The current string's bytes, collected only where a capture could need them. */
  let stringBytes: number[] = []
  let collecting = false
  /** Top-level key awaiting its value, or null between a comma and the next key. */
  let pendingKey: string | null = null
  let afterColon = false

  let model: string | null = null
  let modelSpan: ByteSpan | null = null
  const prefix: number[] = []
  let capturingConversation = false
  let conversationSeen = false
  /** The conversation value is fully captured: it closed, or the prefix limit was reached. */
  let conversationDone = false

  const finished = (): boolean => model !== null && conversationDone

  const closeString = (end: number): void => {
    const value = collecting ? decoder.decode(Uint8Array.from(stringBytes)) : ""
    collecting = false
    stringBytes = []

    if (depth !== 1) return

    if (!afterColon) {
      pendingKey = value
      return
    }
    if (pendingKey === MODEL_KEY && model === null) {
      model = value
      modelSpan = { start: stringStart, end }
    }
    pendingKey = null
  }

  return {
    push(chunk) {
      if (finished()) {
        offset += chunk.length
        return
      }

      for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index]
        if (byte === undefined) continue
        const absolute = offset + index

        if (capturingConversation && prefix.length < prefixLimit) prefix.push(byte)

        if (inString) {
          if (escaped) {
            escaped = false
            if (collecting) stringBytes.push(byte)
            continue
          }
          if (byte === BACKSLASH) {
            escaped = true
            if (collecting) stringBytes.push(byte)
            continue
          }
          if (byte === QUOTE) {
            inString = false
            closeString(absolute)
            continue
          }
          if (collecting) stringBytes.push(byte)
          continue
        }

        switch (byte) {
          case QUOTE:
            inString = true
            stringStart = absolute + 1
            // Only depth-1 strings can be a top-level key or the model value; everything deeper
            // is transcript we must not accumulate.
            collecting = depth === 1
            break
          case COLON:
            if (depth === 1) afterColon = true
            break
          case COMMA:
            if (depth === 1) {
              afterColon = false
              pendingKey = null
            }
            break
          case OPEN_BRACE:
          case OPEN_BRACKET:
            if (
              depth === 1 &&
              afterColon &&
              pendingKey !== null &&
              CONVERSATION_KEYS.has(pendingKey) &&
              !conversationSeen
            ) {
              conversationSeen = true
              capturingConversation = true
              prefix.push(byte)
            }
            depth += 1
            break
          case CLOSE_BRACE:
          case CLOSE_BRACKET:
            depth -= 1
            if (depth <= 1 && capturingConversation) {
              capturingConversation = false
              conversationDone = true
            }
            if (depth === 1) {
              afterColon = false
              pendingKey = null
            }
            break
          default:
            break
        }

        if (capturingConversation && prefix.length >= prefixLimit) {
          capturingConversation = false
          conversationDone = true
        }
        if (finished()) break
      }

      offset += chunk.length
    },

    get done() {
      return finished()
    },

    result: () => ({
      model,
      modelSpan,
      conversationPrefix: Uint8Array.from(prefix),
    }),
  }
}
