import { describe, expect, test } from "bun:test"
import { renderSdkResponse } from "../../../src/providers"
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

describe("a turn whose SDK stream ended mid-block", () => {
  /**
   * `sdk stream closed with unterminated content blocks` — the renderer force-closes the open block
   * and emits its own `message_delta` + `message_stop`, with `stop_reason: null` because nothing
   * ever stated one. Legal Anthropic. Not a legal openai-chat ending.
   */
  const truncated = (): AsyncIterable<unknown> =>
    stream(INIT, MESSAGE_START, BLOCK_START, BLOCK_DELTA)

  test("the client's stream is well-formed: a stated finish, and a terminator", async () => {
    const sse = await asOpenAiChat(truncated())

    expect(isWellFormed(sse)).toBe(true)
    expect(finishReasons(sse).at(-1)).toBe("stop")
    expect(sse.trimEnd().endsWith("data: [DONE]")).toBe(true)
  })

  test("the partial answer still reaches the client — truncated, not discarded", async () => {
    expect(await asOpenAiChat(truncated())).toContain("partial")
  })

  test("exactly one chunk states the finish; the deltas before it state none", async () => {
    const stated = finishReasons(await asOpenAiChat(truncated())).filter(
      (reason) => typeof reason === "string",
    )
    expect(stated).toEqual(["stop"])
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
