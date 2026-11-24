import { tokensIn } from "./clocks"
import { type StubDialect, streamChunks, stubBody } from "./upstream-wire"

/**
 * The stub upstream the bench measures against: in-process, no socket, no provider.
 *
 * In-process on purpose. A loopback server would add a kernel round trip, a TLS-less-but-still-real
 * HTTP parse, and the scheduler's opinion about both to every sample — noise measured in the same
 * milliseconds as the budget being defended. What is left here is the router and nothing else.
 *
 * It answers in three dialects because the router's non-SDK egress paths cost different amounts:
 * `anthropic` for byte passthrough, `openai-chat` and `openai-responses` for the two translations
 * (the second is a ChatGPT/Codex account's wire, and prod's most expensive path). The Agent-SDK
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

/** Test-only correlation injected by the benchmark transport after the production header boundary. */
export const TRIP_HEADER = "x-bench-trip"

export interface Trip {
  /**
   * Monotonic reading when the router called the upstream. With `upstreamLastByteAt` it bounds the
   * time this request spent *waiting*, which is what a per-request overhead subtracts.
   */
  upstreamEnteredAt: number
  /** Monotonic reading when the stub handed the router its first byte. */
  upstreamFirstByteAt: number
  /** Monotonic reading when the stub's last byte went out. */
  upstreamLastByteAt: number
  /** Monotonic reading when the driver read the client's first byte. Zero until it does. */
  clientFirstByteAt: number
  /** When the stub released stream token N (`tok<N> `), so each can be matched at the client. */
  upstreamTokenAt: (number | undefined)[]
  /** Background streams in flight on this app when the router called the upstream for this trip. */
  backgroundActive: number
}

export interface StubOptions {
  /** What the account speaks. `anthropic` is passthrough; the other two are translated. */
  readonly dialect: StubDialect
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
  /** Pads a non-streamed answer's text to about this many bytes of escaped prose. */
  readonly answerBytes?: number
  /**
   * Answer a request whose body asks to stream with a stream of `backgroundChunks`, whatever
   * `stream` says. Lets long background streams and short measured requests share one app.
   */
  readonly streamOnRequest?: boolean
  readonly backgroundChunks?: number
}

export interface StubUpstream {
  /** The `FetchLike` the dispatcher is built with. */
  readonly fetch: (request: Request) => Promise<Response>
  /** Registers a trip before the request that will fill it in. */
  open(id: string): Trip
  /** Background streams the router has open against this stub right now. */
  backgroundActive(): number
}

const DEFAULT_CHUNKS = 16
const DEFAULT_CHUNK_GAP_MS = 1
const DEFAULT_FIRST_BYTE_DELAY_MS = 20

export function stubUpstream(options: StubOptions): StubUpstream {
  const trips = new Map<string, Trip>()
  const chunkCount = options.chunks ?? DEFAULT_CHUNKS
  const gapMs = options.chunkGapMs ?? DEFAULT_CHUNK_GAP_MS
  const delayMs = options.firstByteDelayMs ?? DEFAULT_FIRST_BYTE_DELAY_MS
  /** Background streams the router has open against this stub right now. */
  let backgroundActive = 0

  return {
    backgroundActive: () => backgroundActive,

    open(id) {
      const trip: Trip = {
        upstreamEnteredAt: 0,
        upstreamFirstByteAt: 0,
        upstreamLastByteAt: 0,
        clientFirstByteAt: 0,
        upstreamTokenAt: [],
        backgroundActive: 0,
      }
      trips.set(id, trip)
      return trip
    },

    async fetch(request) {
      const id = request.headers.get(TRIP_HEADER)
      const trip = id === null ? undefined : trips.get(id)
      if (trip !== undefined && id !== null) trips.delete(id)
      if (trip !== undefined) {
        trip.upstreamEnteredAt = performance.now()
        trip.backgroundActive = backgroundActive
      }

      if (options.streamOnRequest === true && !options.stream && (await asksToStream(request))) {
        const chunks = streamChunks(options.dialect, options.backgroundChunks ?? chunkCount)
        backgroundActive += 1
        return sse(chunks, delayMs, gapMs, undefined, () => {
          backgroundActive -= 1
        })
      }

      if (!options.stream) {
        await sleep(delayMs)
        const at = performance.now()
        if (trip !== undefined) {
          trip.upstreamFirstByteAt = at
          trip.upstreamLastByteAt = at
        }
        return json(stubBody(options.dialect, options.answerBytes))
      }

      // Headers now, first token after the wait — the shape every streaming provider has, and the
      // reason time-to-first-token is a separate claim from total latency.
      return sse(streamChunks(options.dialect, chunkCount), delayMs, gapMs, trip)
    },
  }
}

/** Whether the forwarded body sets `stream: true`. Read only when a scenario mixes both shapes. */
async function asksToStream(request: Request): Promise<boolean> {
  const text = await request.clone().text()
  return /"stream"\s*:\s*true/.test(text)
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
  onEnd: () => void = () => undefined,
): Response {
  const encoder = new TextEncoder()
  // Worked out before the stream starts, so stamping a token is one clock read and an assignment:
  // anything the stub does between chunks is time the router's relay has to share the loop with.
  // Only for a measured request — a background stream has no trip, and scanning its hundreds of
  // chunks on every restart would be fixture work competing with the requests being timed.
  const tokens = trip === undefined ? [] : chunks.map(tokensIn)
  // Exactly once, however the stream ends: a cancel mid-delay is followed by an enqueue that
  // throws, and counting both would leave the background-stream count one short for good.
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    onEnd()
  }
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const [index, chunk] of chunks.entries()) {
          await sleep(index === 0 ? delayMs : gapMs)
          // Cancelled while it slept: stop producing rather than enqueue into a closed stream.
          if (ended) return
          controller.enqueue(encoder.encode(chunk))
          if (trip === undefined) continue
          const at = performance.now()
          if (index === 0) trip.upstreamFirstByteAt = at
          // First release only: a closing event may repeat the whole text.
          for (const token of tokens[index] ?? []) trip.upstreamTokenAt[token] ??= at
        }
        if (trip !== undefined) trip.upstreamLastByteAt = performance.now()
        controller.close()
      } finally {
        end()
      }
    },
    cancel: end,
  })

  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
