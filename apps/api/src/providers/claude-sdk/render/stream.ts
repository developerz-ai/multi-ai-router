import { isRouterError } from "@multi-ai-router/core"
import { SdkResultError } from "../result-error"
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
import { drain, jsonResponse, type Primed, type Pump, sseResponse } from "./respond"

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
 * | `assistant` | Its `uuid` to the observer, for the undo fork point (§4). No frame: the content was already seen as `stream_event`s, and its `usage` covers one internal iteration rather than the turn |
 * | `user` | Nothing: the SDK's own internal tool results, which `tools/` accounts for |
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
  /**
   * The uuid of an `assistant` message this turn produced — the point a later undo forks at (§4).
   * Reported for the main turn only: a subagent's message names a turn the client never asked for,
   * and rewinding to it would resume someone else's branch. Called once per assistant message; the
   * last one wins, since that is the message the client will send back next turn.
   */
  onAssistantUuid?(uuid: string): void
  /**
   * The envelope had to force-close `count` content blocks at the end of the turn because the
   * upstream never did (`envelope.ts`). Called at most once, only when `count > 0`: the close keeps
   * the client's parser sound, so without this report the regression that caused it — an upstream
   * or a filter of ours eating a `content_block_stop` — shows up in user transcripts and nowhere
   * else. An alarm for a log line, never a frame.
   */
  onForcedBlockClose?(count: number): void
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
      case "assistant": {
        // Nothing here reaches the client — the content was already seen as `stream_event`s. The
        // uuid is the one fact this message type carries that no other one does (§6).
        const uuid = message.uuid
        if (uuid !== null && message.parentToolUseId === null) {
          observe(() => input.observer?.onAssistantUuid?.(uuid))
        }
        return NO_FRAMES
      }
      case "result":
        // A failed turn that produced nothing for the client is a failure with a real status, not
        // an empty `200`: thrown here, it reaches the invoker before any byte is out, where
        // `errors.ts` reads its sentence and its structured facts. Once content has started the
        // contract has inverted — the frames already sent are the answer, and a `result` that
        // then reports an error (a turn cap after a captured tool call, say) closes the message
        // rather than retracting it.
        if (message.isError && !envelope.started) {
          throw new SdkResultError({
            text: message.errorText,
            apiErrorStatus: message.apiErrorStatus,
            terminalReason: message.terminalReason,
          })
        }
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

  let integrityReported = false
  const finish = (): readonly ClientFrame[] => {
    const frames = envelope.finish(completion)
    if (!integrityReported && envelope.forcedBlockCloses > 0) {
      integrityReported = true
      observe(() => input.observer?.onForcedBlockClose?.(envelope.forcedBlockCloses))
    }
    return frames
  }

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
