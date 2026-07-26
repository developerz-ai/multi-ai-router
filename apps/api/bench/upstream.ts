import type { Dialect } from "@multi-ai-router/core"

/**
 * The stub upstream the bench measures against: in-process, no socket, no provider.
 *
 * In-process on purpose. A loopback server would add a kernel round trip, a TLS-less-but-still-real
 * HTTP parse, and the scheduler's opinion about both to every sample — noise measured in the same
 * milliseconds as the budget being defended. What is left here is the router and nothing else.
 *
 * It answers in two dialects because the router has two non-SDK egress paths and they cost
 * different amounts: `anthropic` for byte passthrough, `openai-chat` for translation. The Agent-SDK
 * path is deliberately absent — it spawns a subprocess per request and is the labeled exception to
 * the overhead budget (CLAUDE.md non-negotiable 8), so benching it here would only dilute the
 * number that matters.
 *
 * **Streams are the point of the timestamps.** Each trip records when the stub let its first byte
 * go and when its last one did. The driver records when the *client* saw its first byte. The
 * difference between the first and third is added time-to-first-token; a client first byte that
 * lands after the stub's last one is a relay that buffered, which is a different failure from a
 * slow one and is reported as such.
 */

/** Correlates one client request with one upstream trip. A client header, so it survives egress. */
export const TRIP_HEADER = "x-bench-trip"

export interface Trip {
  /** Monotonic reading when the stub handed the router its first byte. */
  upstreamFirstByteAt: number
  /** Monotonic reading when the stub's last byte went out. */
  upstreamLastByteAt: number
  /** Monotonic reading when the driver read the client's first byte. Zero until it does. */
  clientFirstByteAt: number
}

export interface StubOptions {
  /** What the account speaks. `anthropic` is passthrough; `openai-chat` is translated. */
  readonly dialect: Extract<Dialect, "anthropic" | "openai-chat">
  readonly stream: boolean
  /** Chunks after the first. Long enough that a buffering relay is unmistakable, not subtle. */
  readonly chunks?: number
  /** Gap between chunks, ms. The stub's own think time — never charged to the router. */
  readonly chunkGapMs?: number
  /**
   * Time before the first byte, ms. Not decoration: an upstream that answers instantly makes any
   * concurrency at all saturate the event loop, and the resulting queueing lands in
   * `router_overhead_seconds` as though the router had spent it. No provider on earth answers in
   * zero, so a stub that does would report a number no deployment will ever see.
   */
  readonly firstByteDelayMs?: number
}

export interface StubUpstream {
  /** The `FetchLike` the dispatcher is built with. */
  readonly fetch: (request: Request) => Promise<Response>
  /** Registers a trip before the request that will fill it in. */
  open(id: string): Trip
}

const DEFAULT_CHUNKS = 16
const DEFAULT_CHUNK_GAP_MS = 1
const DEFAULT_FIRST_BYTE_DELAY_MS = 20

export function stubUpstream(options: StubOptions): StubUpstream {
  const trips = new Map<string, Trip>()
  const chunkCount = options.chunks ?? DEFAULT_CHUNKS
  const gapMs = options.chunkGapMs ?? DEFAULT_CHUNK_GAP_MS
  const delayMs = options.firstByteDelayMs ?? DEFAULT_FIRST_BYTE_DELAY_MS

  return {
    open(id) {
      const trip: Trip = { upstreamFirstByteAt: 0, upstreamLastByteAt: 0, clientFirstByteAt: 0 }
      trips.set(id, trip)
      return trip
    },

    async fetch(request) {
      const id = request.headers.get(TRIP_HEADER)
      const trip = id === null ? undefined : trips.get(id)
      if (trip !== undefined && id !== null) trips.delete(id)

      if (!options.stream) {
        await sleep(delayMs)
        const at = performance.now()
        if (trip !== undefined) {
          trip.upstreamFirstByteAt = at
          trip.upstreamLastByteAt = at
        }
        return json(body(options.dialect))
      }

      // Headers now, first token after the wait — the shape every streaming provider has, and the
      // reason time-to-first-token is a separate claim from total latency.
      return sse(streamChunks(options.dialect, chunkCount), delayMs, gapMs, trip)
    },
  }
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

/**
 * The body arrives in pieces with a real gap between them, so a relay that accumulates before
 * forwarding shows up as a client first byte arriving `chunks * gap` late rather than as a
 * rounding difference.
 */
function sse(
  chunks: readonly string[],
  delayMs: number,
  gapMs: number,
  trip: Trip | undefined,
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [index, chunk] of chunks.entries()) {
        await sleep(index === 0 ? delayMs : gapMs)
        controller.enqueue(encoder.encode(chunk))
        if (trip !== undefined && index === 0) trip.upstreamFirstByteAt = performance.now()
      }
      if (trip !== undefined) trip.upstreamLastByteAt = performance.now()
      controller.close()
    },
  })

  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const MODEL = "claude-opus-5"
const UPSTREAM_MODEL = "gpt-4o"
const TOKENS_IN = 24
const TOKENS_OUT = 32

function body(dialect: StubOptions["dialect"]): unknown {
  if (dialect === "anthropic") {
    return {
      id: "msg_bench",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text: "bench" }],
      stop_reason: "end_turn",
      usage: { input_tokens: TOKENS_IN, output_tokens: TOKENS_OUT },
    }
  }
  return {
    id: "chatcmpl-bench",
    object: "chat.completion",
    model: UPSTREAM_MODEL,
    choices: [
      { index: 0, message: { role: "assistant", content: "bench" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: TOKENS_IN, completion_tokens: TOKENS_OUT },
  }
}

function streamChunks(dialect: StubOptions["dialect"], count: number): readonly string[] {
  const deltas = Array.from({ length: Math.max(1, count) }, (_unused, index) =>
    dialect === "anthropic" ? anthropicDelta(index) : openAiDelta(index),
  )
  return dialect === "anthropic"
    ? [anthropicStart(), ...deltas, anthropicEnd()]
    : [...deltas, openAiEnd()]
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

function anthropicStart(): string {
  return (
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_bench",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        usage: { input_tokens: TOKENS_IN, output_tokens: 0 },
      },
    }) +
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })
  )
}

function anthropicDelta(index: number): string {
  return event("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: `tok${index} ` },
  })
}

function anthropicEnd(): string {
  return (
    event("content_block_stop", { type: "content_block_stop", index: 0 }) +
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: TOKENS_OUT },
    }) +
    event("message_stop", { type: "message_stop" })
  )
}

function openAiChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-bench", object: "chat.completion.chunk", model: UPSTREAM_MODEL, ...payload })}\n\n`
}

function openAiDelta(index: number): string {
  const delta = index === 0 ? { role: "assistant", content: "tok0 " } : { content: `tok${index} ` }
  return openAiChunk({ choices: [{ index: 0, delta }] })
}

function openAiEnd(): string {
  return (
    openAiChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    openAiChunk({
      choices: [],
      usage: { prompt_tokens: TOKENS_IN, completion_tokens: TOKENS_OUT },
    }) +
    "data: [DONE]\n\n"
  )
}
