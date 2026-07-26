/**
 * Token counts, read off a response **as it flows past**.
 *
 * The passthrough body is opaque and the stream is never buffered, so usage cannot be recovered by
 * parsing a completed response — there is no completed response to parse. Instead the relay hands
 * every chunk here *after* it has already been enqueued for the client, and this scans it. Nothing
 * in this module can delay a byte.
 *
 * The `UsageRecord` stores the **upstream's own numbers**, so both dialect families are read as
 * the upstream words them (docs/idea/06-protocol-translation.md#usage-and-token-fields):
 *
 * | Field | Family | Lands in |
 * |---|---|---|
 * | `input_tokens` | Anthropic | `tokensIn` — the uncached remainder |
 * | `prompt_tokens` | OpenAI | `tokensIn`, **minus** `cached_tokens`, which it includes |
 * | `output_tokens` / `completion_tokens` | both | `tokensOut` |
 * | `cache_read_input_tokens` / `cached_tokens` | both | `cacheReadTokens` |
 * | `cache_creation_input_tokens` | Anthropic | `cacheWriteTokens` — no OpenAI counterpart |
 *
 * Values are taken as the **maximum** seen, because a stream reports them cumulatively: Anthropic
 * puts input on `message_start` and the final output count on `message_delta`.
 */

export interface TokenCounts {
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

export const ZERO_TOKENS: TokenCounts = {
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

export interface TokenObserver {
  observe(chunk: Uint8Array): void
  counts(): TokenCounts
}

const FIELD = /"(\w*tokens\w*)"\s*:\s*(\d+)/g

/** Enough to span a field name and its value split across a chunk boundary. */
const CARRY_CHARS = 96

interface Slots {
  inputAnthropic: number
  inputOpenAi: number
  output: number
  cacheRead: number
  cacheWrite: number
}

function apply(slots: Slots, field: string, value: number): void {
  switch (field) {
    case "input_tokens":
      slots.inputAnthropic = Math.max(slots.inputAnthropic, value)
      return
    case "prompt_tokens":
      slots.inputOpenAi = Math.max(slots.inputOpenAi, value)
      return
    case "output_tokens":
    case "completion_tokens":
      slots.output = Math.max(slots.output, value)
      return
    case "cache_read_input_tokens":
    case "cached_tokens":
      slots.cacheRead = Math.max(slots.cacheRead, value)
      return
    case "cache_creation_input_tokens":
      slots.cacheWrite = Math.max(slots.cacheWrite, value)
      return
    default:
      // `total_tokens`, `reasoning_tokens`, and anything a provider adds later: recorded nowhere
      // rather than guessed into a column that means something else.
      return
  }
}

/**
 * An observer that reads nothing and reports zero.
 *
 * For the responses whose token fields are **not** a statement of what was spent. A
 * `count_tokens` answer is exactly that: `{"input_tokens": 4531}` is a measurement of a prompt
 * nobody ran, and scanning it would price a question as though it were a completion and inflate
 * every spend report that sums the column.
 */
export const NO_TOKEN_OBSERVER: TokenObserver = {
  observe: () => undefined,
  counts: () => ZERO_TOKENS,
}

export function createTokenObserver(): TokenObserver {
  const decoder = new TextDecoder("utf-8")
  const slots: Slots = {
    inputAnthropic: 0,
    inputOpenAi: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
  let carry = ""

  return {
    observe(chunk) {
      const text = carry + decoder.decode(chunk, { stream: true })
      // `tokens` is in every field name we read, so one substring test skips the regex entirely
      // for the overwhelming majority of chunks, which are content deltas.
      if (text.includes("tokens")) {
        FIELD.lastIndex = 0
        for (let match = FIELD.exec(text); match !== null; match = FIELD.exec(text)) {
          const [, field, raw] = match
          if (field === undefined || raw === undefined) continue
          const value = Number(raw)
          if (Number.isSafeInteger(value)) apply(slots, field, value)
        }
      }
      carry = text.length > CARRY_CHARS ? text.slice(-CARRY_CHARS) : text
    },

    counts() {
      const cacheRead = slots.cacheRead
      const tokensIn =
        slots.inputAnthropic > 0
          ? slots.inputAnthropic
          : Math.max(0, slots.inputOpenAi - (slots.inputOpenAi > 0 ? cacheRead : 0))

      return {
        tokensIn,
        tokensOut: slots.output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: slots.cacheWrite,
      }
    },
  }
}
