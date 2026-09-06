import { describe, expect, test } from "bun:test"
import { renderSdkResponse, type TruncatedTurn } from "../../../src/providers"
import { relayTranslatedResponse } from "../../../src/services/dataplane/relay-translate"
import type { TranslationContext } from "../../../src/services/translate"
import { translationPair } from "../../../src/services/translate/registry"

/**
 * **How an Agent-SDK turn ends, read in the dialect the client actually speaks.**
 *
 * Every piece below is unit-tested on its own — the envelope's funnel, the translator's event
 * table — and none of those tests could see this bug, because it lives in the *seam*: the renderer
 * ends a truncated turn the way Anthropic allows, the translator forwards what it is given, and the
 * openai-chat stream that comes out the far end has no ending a client can act on.
 *
 * Both shapes here are transcribed from production on 2026-09-06, when a `/feature` agent on
 * opencode failed a long tool-heavy turn with `ProviderShared.stream: Failed to read
 * developerz-router/openai-compatible-chat stream` — no HTTP status, the response begun and then
 * unreadable. The pod log for the same minute carried `sdk stream closed with unterminated content
 * blocks` twice, on two different accounts, including the failover retry.
 *
 * So the assertions are deliberately about the **bytes**, not about the intermediate objects: an
 * openai-chat stream is well-formed when some chunk states a `finish_reason` and the stream ends
 * with `[DONE]`, and a reader is entitled to wait for exactly those two things.
 */

const CONTEXT: TranslationContext = {
  created: 1_700_000_000,
  model: "default",
  fallbackId: "chatcmpl_test",
  openAiChatCeiling: { defaultMaxTokens: 4_096 },
}

/** The pair an openai-chat client gets when the account behind it speaks Anthropic — the SDK. */
const PAIR = translationPair("openai-chat", "anthropic")

function wire(raw: Record<string, unknown>): Record<string, unknown> {
  return { type: "stream_event", event: raw, parent_tool_use_id: null }
}

const INIT = { type: "system", subtype: "init", session_id: "sess_1" }

const MESSAGE_START = wire({
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [],
  },
})

const BLOCK_START = wire({
  type: "content_block_start",
  index: 0,
  content_block: { type: "text", text: "" },
})

const BLOCK_DELTA = wire({
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text: "partial" },
})

/** The SDK stream, rendered to Anthropic and then translated the way a chat client receives it. */
async function asOpenAiChat(messages: AsyncIterable<unknown>): Promise<string> {
  const upstream = await renderSdkResponse({ messages, model: "claude-opus-5", stream: true })
  if (PAIR === null) throw new Error("openai-chat ← anthropic has no translation pair")
  return await relayTranslatedResponse({ upstream, pair: PAIR, context: CONTEXT }).text()
}

function stream(...messages: readonly unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message
    },
  }
}

interface Chunk {
  readonly choices?: readonly { readonly finish_reason?: string | null }[]
  readonly error?: { readonly message?: string }
}

/** Every `data:` payload except the sentinel, in order. */
function chunks(sse: string): Chunk[] {
  return sse
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
    .map((block) => JSON.parse(block.slice("data: ".length)) as Chunk)
}

function finishReasons(sse: string): (string | null | undefined)[] {
  return chunks(sse).flatMap((chunk) => (chunk.choices ?? []).map((choice) => choice.finish_reason))
}

/** The two things a reader waits for, and the only two this file asserts. */
function isWellFormed(sse: string): boolean {
  return finishReasons(sse).some((reason) => typeof reason === "string") && sse.includes("[DONE]")
}

describe("a turn whose SDK stream ended mid-block, having never stated an ending", () => {
  /**
   * The shape production kept producing: two chunks, no `message_delta`, no `result`, the stream
   * simply over. Reproduced with a plain tool-free request — one run gave 2 chunks in 11 s where the
   * next gave 3,892 lines in 122 s — so it is nothing to do with tools, harnesses, or session
   * binding. The upstream stopped while it was still writing.
   */
  const truncated = (): AsyncIterable<unknown> =>
    stream(INIT, MESSAGE_START, BLOCK_START, BLOCK_DELTA)

  test("it is answered as the failure it is, not as a completion", async () => {
    const sse = await asOpenAiChat(truncated())

    // The one component that knew the answer was broken used to be the only one that said nothing:
    // it logged the truncation and handed the client a normal, complete-looking answer.
    expect(chunks(sse).some((chunk) => chunk.error !== undefined)).toBe(true)
    expect(sse).toContain("the upstream ended this turn while it was still writing")
  })

  test("and it is still a stream a client can finish reading", async () => {
    const sse = await asOpenAiChat(truncated())

    expect(isWellFormed(sse)).toBe(true)
    expect(sse.trimEnd().endsWith("data: [DONE]")).toBe(true)
  })

  test("the partial answer still reaches the client ahead of the error", async () => {
    const sse = await asOpenAiChat(truncated())
    const payloads = chunks(sse)
    const contentAt = payloads.findIndex((chunk) => JSON.stringify(chunk).includes("partial"))
    const errorAt = payloads.findIndex((chunk) => chunk.error !== undefined)

    expect(contentAt).toBeGreaterThanOrEqual(0)
    expect(errorAt).toBeGreaterThan(contentAt)
  })

  test("a non-streaming turn of the same shape is a real status, so the chain can fail over", async () => {
    const response = await renderSdkResponse({
      messages: truncated(),
      model: "claude-opus-5",
      stream: false,
    })

    // Not a 200 carrying half an answer: no byte is on the wire yet, so this attempt can still fail
    // honestly and the next account gets its turn.
    expect(response.status).toBe(502)
  })
})

describe("a turn that stated its ending and merely dropped a content_block_stop", () => {
  /**
   * A whole answer with one framing event missing — repaired, and *not* a truncation. Keeping the
   * two apart is what stops this change turning every dropped stop event into a failed turn.
   */
  test("it finishes cleanly on the reason the upstream stated", async () => {
    const sse = await asOpenAiChat(
      stream(INIT, MESSAGE_START, BLOCK_START, BLOCK_DELTA, {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        usage: {},
      }),
    )

    expect(chunks(sse).some((chunk) => chunk.error !== undefined)).toBe(false)
    expect(finishReasons(sse).at(-1)).toBe("stop")
    expect(isWellFormed(sse)).toBe(true)
  })
})

describe("a turn whose subprocess died after the first byte", () => {
  /**
   * The renderer cannot change the status once bytes are out, so it spells the failure as a
   * terminal Anthropic `error` frame. Before this suite the translation of that frame was an error
   * object and then nothing at all — no finish, no `[DONE]` — so the reader waited at EOF and
   * reported a parse failure with the real cause nowhere in it.
   */
  const died = (): AsyncIterable<unknown> => ({
    async *[Symbol.asyncIterator]() {
      yield INIT
      yield MESSAGE_START
      yield BLOCK_START
      yield BLOCK_DELTA
      throw new Error("Claude Code process exited with code 1")
    },
  })

  test("the stream is still terminated, so the reader finishes instead of waiting", async () => {
    const sse = await asOpenAiChat(died())

    expect(isWellFormed(sse)).toBe(true)
    expect(sse.trimEnd().endsWith("data: [DONE]")).toBe(true)
  })

  test("the error is the first thing after the content, never masked by the finish", async () => {
    const payloads = chunks(await asOpenAiChat(died()))
    const errorAt = payloads.findIndex((chunk) => chunk.error !== undefined)
    const finishAt = payloads.findIndex((chunk) =>
      (chunk.choices ?? []).some((choice) => typeof choice.finish_reason === "string"),
    )

    expect(errorAt).toBeGreaterThanOrEqual(0)
    expect(finishAt).toBeGreaterThan(errorAt)
  })

  test("the router's own words, never the SDK's, describe the failure", async () => {
    const sse = await asOpenAiChat(died())

    expect(sse).toContain("the Claude Agent SDK stream failed")
    expect(sse).not.toContain("Claude Code process exited")
  })
})

describe("a healthy turn is unchanged", () => {
  test("it finishes on the reason the upstream actually stated", async () => {
    const sse = await asOpenAiChat(
      stream(
        INIT,
        MESSAGE_START,
        BLOCK_START,
        BLOCK_DELTA,
        wire({ type: "content_block_stop", index: 0 }),
        { type: "result", subtype: "success", stop_reason: "tool_use", usage: {} },
      ),
    )

    // `tool_use`, not the conservative fallback: a stated reason is never overwritten.
    expect(finishReasons(sse).at(-1)).toBe("tool_calls")
    expect(isWellFormed(sse)).toBe(true)
  })
})

/**
 * The alarm's own fields, because the first cut of this line shipped two of them broken: the block
 * kind was never recorded at `content_block_start`, so every truncation reported `kinds: [""]`, and
 * the message counter was called `messages` — a key on the log redactor's list — so it reached the
 * log as `[REDACTED]` (2026-09-06). A diagnostic nobody can read is not a diagnostic.
 */
describe("what the truncation alarm reports", () => {
  async function alarmFor(messages: AsyncIterable<unknown>) {
    let detail: TruncatedTurn | null = null
    const response = await renderSdkResponse({
      messages,
      model: "claude-opus-5",
      stream: true,
      observer: {
        onTruncatedTurn: (seen) => {
          detail = seen
        },
      },
    })
    await response.text()
    return detail
  }

  test("it names what was left open, so a truncated tool call is not read as truncated prose", async () => {
    const detail = await alarmFor(
      stream(
        INIT,
        MESSAGE_START,
        wire({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
        }),
        wire({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"pa' },
        }),
      ),
    )

    expect(detail?.kinds).toEqual(["tool_use"])
    expect(detail?.blocks).toBe(1)
  })

  test("it says which early ending it was: no result, and the SDK's last word", async () => {
    const detail = await alarmFor(stream(INIT, MESSAGE_START, BLOCK_START, BLOCK_DELTA))

    expect(detail?.sawResult).toBe(false)
    expect(detail?.lastEvent).toBe("content_block_delta")
    expect(detail?.lastSystemSubtype).toBe("init")
    // The counter survives the log redactor, which `messages` did not.
    expect(detail?.sdkMessages).toBeGreaterThan(0)
  })

  test("a text block reports as text", async () => {
    expect((await alarmFor(stream(INIT, MESSAGE_START, BLOCK_START, BLOCK_DELTA)))?.kinds).toEqual([
      "text",
    ])
  })

  test("a turn that closed its own blocks raises nothing at all", async () => {
    const clean = await alarmFor(
      stream(
        INIT,
        MESSAGE_START,
        BLOCK_START,
        BLOCK_DELTA,
        wire({
          type: "content_block_stop",
          index: 0,
        }),
        {
          type: "result",
          subtype: "success",
          stop_reason: "end_turn",
          usage: {},
        },
      ),
    )

    expect(clean).toBeNull()
  })

  test("a repaired block still alarms, even though the turn finishes cleanly", async () => {
    // A dropped `content_block_stop` behind a stated ending is repaired rather than failed
    // (`envelope.ts`), and the repair is still worth a line: it is an upstream, or a filter of
    // ours, eating an event nobody would otherwise see.
    const repaired = await alarmFor(
      stream(INIT, MESSAGE_START, BLOCK_START, BLOCK_DELTA, {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        usage: {},
      }),
    )

    expect(repaired?.blocks).toBe(1)
    expect(repaired?.sawResult).toBe(true)
  })
})

/**
 * **When a truncated turn is retryable, and when it is not** — asked because a dead turn can park a
 * worker, and worth an answer rather than an assumption.
 *
 * The answer is a fact about the shape, not a policy: a block can only be *open* if its
 * `content_block_start` was forwarded, and on the streaming path a forwarded frame is a written
 * byte. So by the time a turn can be called truncated, the client already holds part of it and
 * "never retry after bytes are on the wire" applies with nothing left to decide.
 *
 * The non-streaming path answers the same question the other way, for the same reason: nothing is
 * written until the whole object is, so a truncated fold is still free to be a real status — and it
 * is, which is what lets the chain try another account there. Two paths, one rule, opposite
 * outcomes. These tests exist so that stays true, and so nobody has to re-derive it.
 */
describe("whether a truncated turn can be failed over", () => {
  const truncatedToolTurn = (): AsyncIterable<unknown> =>
    stream(
      INIT,
      MESSAGE_START,
      BLOCK_START,
      BLOCK_DELTA,
      wire({ type: "content_block_stop", index: 0 }),
      wire({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
      }),
    )

  test("streaming: not retryable, because the client already holds part of the answer", async () => {
    const sse = await asOpenAiChat(truncatedToolTurn())

    // The content that did arrive is kept — this is the production shape, where 51 frames had
    // already gone out before the block opened.
    expect(sse).toContain("partial")
    expect(chunks(sse).some((chunk) => chunk.error !== undefined)).toBe(true)
    expect(isWellFormed(sse)).toBe(true)
  })

  test("non-streaming: a real status, so the chain does try another account", async () => {
    const response = await renderSdkResponse({
      messages: truncatedToolTurn(),
      model: "claude-opus-5",
      stream: false,
    })

    // No byte is on the wire until the whole object is, so this attempt is still free to fail.
    expect(response.status).toBe(502)
  })

  test("and an empty turn that did not truncate is an empty answer, never a retry", async () => {
    const response = await renderSdkResponse({
      messages: stream(INIT, MESSAGE_START, {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        usage: {},
      }),
      model: "claude-opus-5",
      stream: false,
    })

    expect(response.status).toBe(200)
  })
})
