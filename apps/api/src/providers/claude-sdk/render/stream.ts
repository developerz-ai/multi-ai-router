import { isRouterError } from "@multi-ai-router/core"
import { type ClientFrame, type Completion, createEnvelope, type Envelope } from "./envelope"
import { readSdkMessage, readWireEvent } from "./events"
import {
  createIdleGuard,
  DEFAULT_STREAM_PACING,
  type IdleGuard,
  type StreamPacing,
  type Ticker,
} from "./idle-guard"
import { createMessageFold } from "./message"

/**
 * SDK messages in, an Anthropic Messages `Response` out — the front door of re-synthesis.
 *
 * §6 opens with the sentence this module exists to honour: **there is nothing to proxy.** Even
 * `POST /v1/messages` against a Claude subscription is rebuilt rather than relayed, because the SDK
 * never speaks HTTP to us; it yields its own message objects and exactly one of their types carries
 * anything a client may see. So this discriminates on `message.type` and routes each one to the
 * single place it belongs (docs/idea/11-anthropic-agent-sdk.md §6):
 *
 * | Type | Where it goes |
 * |---|---|
 * | `stream_event` | The envelope — the **only** payload that reaches the client |
 * | `system` (`init`) | `session_id` to the observer, for the Session mapping (§4) |
 * | `rate_limit_event` | Account quota state via the observer (§5). Never forwarded |
 * | `result` | The **authoritative** usage and stop reason for the terminal `message_delta` |
 * | `assistant` / `user` | Nothing: already seen as `stream_event`s, and an `assistant`'s `usage` covers one internal iteration rather than the turn |
 *
 * **The status is decided before the first byte.** The response is not constructed until the first
 * client frame exists, so a stall or a subprocess death on the way to it surfaces as a real HTTP
 * status — a `504` from the idle guard, the classified failure otherwise — instead of a `200`
 * carrying an apology. After that first byte the contract inverts: nothing is retried, and a
 * failure is spelled as a terminal SSE `error` frame, the only honest close for a response already
 * in flight (§6, `server.ts:2333`). Awaiting the first frame costs nothing — it is the first thing
 * that would have been written anyway.
 *
 * **A non-streaming client is served by the same events.** `includePartialMessages: true` is
 * unconditional (`options.ts`), so `stream: false` folds the identical frame sequence into one body
 * (`message.ts`) rather than reading the SDK a second, differently-shaped way.
 *
 * The OpenAI dialects are not this module's problem, and deliberately so: the SDK is rendered to
 * Anthropic **once**, and `services/translate` carries it the rest of the way. A second SDK →
 * OpenAI renderer would be a second place for the loss to happen differently (§6).
 */

export interface SdkRenderObserver {
  /** The SDK's own session id, from `system`/`init`. Captured for the Session mapping (§4). */
  onSession?(sessionId: string): void
  /** `rate_limit_info` from a `rate_limit_event`. Account state, never a client-visible frame (§5). */
  onRateLimit?(info: unknown): void
}

export interface SdkRenderInput {
  /**
   * The SDK's message stream. Typed `unknown` because it is validated here: the SDK's own types
   * describe a subprocess's JSON, and a description is not a check (`events.ts`).
   */
  readonly messages: AsyncIterable<unknown>
  /** The model after the Account's alias map — the fallback until the SDK names one of its own. */
  readonly model: string
  /** Whether the client asked for SSE. */
  readonly stream: boolean
  readonly pacing?: StreamPacing
  /** Injected timers. Defaults to real ones. */
  readonly ticker?: Ticker
  /** Injected id generation, so a test can assert an exact id. */
  readonly newId?: () => string
  readonly observer?: SdkRenderObserver
}

const EVENT_STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
} as const

const JSON_HEADERS = { "content-type": "application/json" } as const

/** The keep-alive comment. An SSE comment line carries no event and no data — only a byte. */
const PING = ": ping\n\n"

/**
 * A failure after bytes are out cannot change the status, so it is spelled in the body. The type is
 * Anthropic's generic server-side one; naming the *class* of SDK failure belongs with the module
 * that reads the subprocess's stderr, not here.
 */
const ERROR_TYPE = "api_error"
const GENERIC_ERROR = "the Claude Agent SDK stream failed"

/**
 * A non-streaming turn that ended in an upstream `error` event answers with the upstream's own
 * body, and must not answer `200` while doing it. `502` is the honest reading of "the upstream said
 * no and this build cannot yet say which no it was" — reading an SDK failure's *class* off the
 * subprocess is `errors.ts`'s job, not the renderer's (docs/idea/11-anthropic-agent-sdk.md §9).
 */
const UPSTREAM_ERROR_STATUS = 502

export async function renderSdkResponse(input: SdkRenderInput): Promise<Response> {
  const pump = createPump(input)

  let primed: Primed
  try {
    primed = await pump.prime()
  } catch (error) {
    pump.close()
    throw error
  }

  if (input.stream) return sseResponse(pump, primed)

  // No byte is on the wire until the whole object is, so a failure here is still allowed to be a
  // real status. It is thrown for the chain to render rather than dressed up as a `200`.
  try {
    const fold = createMessageFold()
    fold.push(primed.frames)
    if (!primed.done) await drain(pump, (frames) => fold.push(frames))
    return jsonResponse(fold.body(), fold.failed() ? UPSTREAM_ERROR_STATUS : 200)
  } finally {
    pump.close()
  }
}

/** `done` is true when the SDK loop is already over and `frames` are its terminal ones. */
interface Primed {
  readonly frames: readonly ClientFrame[]
  readonly done: boolean
}

interface Pump {
  /** Reads until the first client frames exist, or the loop ends and its terminal frames do. */
  prime(): Promise<Primed>
  /** @returns the next client frames, or null once the loop has ended. */
  next(): Promise<readonly ClientFrame[] | null>
  /** The terminal frames the client is owed. */
  finish(): readonly ClientFrame[]
  /** The terminal `error` frame for a failure that arrived after the first byte. */
  fail(error: unknown): readonly ClientFrame[]
  /** Installs the keep-alive writer, once a client stream exists to write to. */
  heartbeat(write: () => void): void
  /** Client bytes went out; the keep-alive clock restarts. */
  wrote(): void
  close(): void
}

const NO_FRAMES: readonly ClientFrame[] = []

function createPump(input: SdkRenderInput): Pump {
  const iterator = input.messages[Symbol.asyncIterator]()
  const envelope: Envelope = createEnvelope({
    model: input.model,
    ...(input.newId === undefined ? {} : { newId: input.newId }),
  })

  let onHeartbeat: (() => void) | null = null
  const guard: IdleGuard = createIdleGuard({
    pacing: input.pacing ?? DEFAULT_STREAM_PACING,
    ...(input.ticker === undefined ? {} : { ticker: input.ticker }),
    // A non-streaming client has no connection to keep alive: it gets one object at the end, and a
    // keep-alive comment has nowhere to go. No heartbeat means no timer at all for that shape.
    ...(input.stream ? { onHeartbeat: () => onHeartbeat?.() } : {}),
  })

  // The `result` message is authoritative for both; an `assistant`'s covers one iteration only.
  let completion: Completion = { stopReason: null, usage: null }

  /** An observer belongs to whoever passed it in, and a broken one must not break a response. */
  const observe = (report: () => void): void => {
    try {
      report()
    } catch {
      // Session capture and quota ingestion degrade for this request. The stream continues.
    }
  }

  const handle = (value: unknown): readonly ClientFrame[] => {
    const message = readSdkMessage(value)
    if (message === null) return NO_FRAMES

    switch (message.type) {
      case "stream_event": {
        const event = readWireEvent(message.event)
        if (event === null) return NO_FRAMES
        // A non-null `parent_tool_use_id` means a subagent produced this — a turn the client never
        // asked for. The envelope still sees it, so a filtered block loses its whole triple and its
        // numbering stays out of the answer's.
        return envelope.push(event, message.parentToolUseId)
      }
      case "system": {
        const sessionId = message.sessionId
        if (message.subtype === "init" && sessionId !== null) {
          observe(() => input.observer?.onSession?.(sessionId))
        }
        return NO_FRAMES
      }
      case "rate_limit_event":
        observe(() => input.observer?.onRateLimit?.(message.rateLimitInfo))
        return NO_FRAMES
      case "result":
        completion = { stopReason: message.stopReason, usage: message.usage }
        return NO_FRAMES
      default:
        return NO_FRAMES
    }
  }

  const next = async (): Promise<readonly ClientFrame[] | null> => {
    const step = await guard.race(iterator.next())
    return step.done === true ? null : handle(step.value)
  }

  const finish = (): readonly ClientFrame[] => envelope.finish(completion)

  return {
    next,
    finish,

    async prime() {
      for (;;) {
        const frames = await next()
        if (frames === null) return { frames: finish(), done: true }
        if (frames.length > 0) return { frames, done: false }
      }
    },

    fail(error) {
      const message = isRouterError(error) ? error.message : GENERIC_ERROR
      return envelope.fail(ERROR_TYPE, message)
    },

    heartbeat(write) {
      onHeartbeat = write
    },

    wrote() {
      guard.wrote()
    },

    close() {
      onHeartbeat = null
      guard.close()
      // Release the iterator so a generator's `finally` runs. The *subprocess* is terminated by the
      // abort signal, never from here. A source that refuses to close is not this module's failure,
      // so its rejection is swallowed rather than surfaced as an unhandled one.
      iterator.return?.().catch(() => {})
    },
  }
}

async function drain(pump: Pump, sink: (frames: readonly ClientFrame[]) => void): Promise<void> {
  for (;;) {
    const frames = await pump.next()
    if (frames === null) break
    sink(frames)
  }
  sink(pump.finish())
}

function sseResponse(pump: Pump, primed: Primed): Response {
  const encoder = new TextEncoder()

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string): void => {
        if (text.length === 0) return
        // Enqueue first. Everything after this line happens on time the client already has.
        controller.enqueue(encoder.encode(text))
        pump.wrote()
      }
      pump.heartbeat(() => write(PING))

      try {
        write(encode(primed.frames))
        if (!primed.done) await drain(pump, (frames) => write(encode(frames)))
      } catch (error) {
        // Bytes are already out, so the status cannot say this. The frame does.
        write(encode(pump.fail(error)))
      } finally {
        pump.close()
        controller.close()
      }
    },

    cancel() {
      pump.close()
    },
  })

  return new Response(body, { status: 200, headers: EVENT_STREAM_HEADERS })
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function encode(frames: readonly ClientFrame[]): string {
  let out = ""
  for (const frame of frames) out += `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`
  return out
}
