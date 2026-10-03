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
 * SDK events become Anthropic frames; other messages supply session, quota, usage, or failure facts.
 * Streaming starts at the first frame and reports later failures as terminal errors. Non-streaming
 * folds the same events in memory, so its failures can still change the HTTP status.
 * See docs/idea/11-anthropic-agent-sdk.md §6.
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
   * The turn ended with content blocks still open, so the envelope closed them and answered with an
   * error rather than a completion (`envelope.ts`). Called at most once, and only then.
   *
   * Everything on {@link TruncatedTurn} is here because it was asked for by someone staring at this
   * happening in production with no way to tell *which* early ending it was: the query iterator
   * completing, a `result` arriving mid-block, or the subprocess dying. An alarm for a log line,
   * never a frame.
   */
  onTruncatedTurn?(detail: TruncatedTurn): void
}

/** What the renderer knew at the moment a turn stopped mid-answer. Diagnostics only. */
export interface TruncatedTurn {
  /** How many blocks had to be force-closed. Always at least one. */
  readonly blocks: number
  /** What each of them was: `text`, `tool_use`, `thinking`. A truncated tool call is its own bug. */
  readonly kinds: readonly string[]
  /** The last SDK message type read before the stream ended — `stream_event`, `result`, … */
  readonly lastMessage: string | null
  /** The last wire event type inside it, when the last message carried one. */
  readonly lastEvent: string | null
  /** Whether the SDK's authoritative `result` arrived at all. False means the loop simply ended. */
  readonly sawResult: boolean
  /**
   * The `subtype` of the last `system` message, when the turn's last word was one.
   *
   * The SDK says several different things through `system`, and the difference between them is the
   * difference between a session opening and a run being cut short — so the subtype is the fact,
   * not the type.
   */
  readonly lastSystemSubtype: string | null
  /**
   * SDK messages read on this turn. A stream that ended after two chunks says so here.
   *
   * Not `messages`: that key is on the log redactor's list — it is what a request body calls its
   * conversation — so a field named that arrives in the log as `[REDACTED]`, which is exactly what
   * happened to the first cut of this line (2026-09-06).
   */
  readonly sdkMessages: number
  /** Client frames emitted before the truncation — how much of the answer the client did get. */
  readonly frames: number
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
  readonly terminate?: (reason?: unknown) => void
  readonly observer?: SdkRenderObserver
}

/**
 * A failure after bytes are out cannot change the status, so it is spelled in the body. The type is
 * Anthropic's generic server-side one; naming the *class* of SDK failure belongs with the module
 * that reads the subprocess's stderr, not here.
 */
const ERROR_TYPE = "api_error"
const GENERIC_ERROR = "the Claude Agent SDK stream failed"

/** Upstream error frames without a classified failure become non-streaming 502 responses. */
const UPSTREAM_ERROR_STATUS = 502

export async function renderSdkResponse(input: SdkRenderInput): Promise<Response> {
  const pump = createPump(input)

  let primed: Primed
  try {
    primed = await pump.prime()
  } catch (error) {
    pump.terminate(error)
    pump.close()
    throw error
  }

  // Only streaming has delivered client bytes here. Non-streaming failures remain retryable.
  if (input.stream) return sseResponse(pump, primed)

  // No byte is on the wire until the whole object is, so a failure here is still allowed to be a
  // real status. It is thrown for the chain to render rather than dressed up as a `200`.
  try {
    const fold = createMessageFold()
    fold.push(primed.frames)
    if (!primed.done) await drain(pump, (frames) => fold.push(frames))
    return jsonResponse(fold.body(), fold.failed() ? UPSTREAM_ERROR_STATUS : 200)
  } catch (error) {
    pump.terminate(error)
    throw error
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

  // Read only when a turn truncates, and cheap enough to keep unconditionally: four counters cost
  // nothing beside a subprocess, and a diagnostic that has to be switched on is one nobody has on
  // when the incident happens.
  let lastMessage: string | null = null
  let lastEvent: string | null = null
  let lastSystemSubtype: string | null = null
  let sawResult = false
  let sdkMessages = 0
  let frames = 0

  /** An observer belongs to whoever passed it in, and a broken one must not break a response. */
  const observe = (report: () => void): void => {
    try {
      report()
    } catch {
      // Session capture and quota ingestion degrade for this request. The stream continues.
    }
  }

  const handle = (value: unknown): readonly ClientFrame[] => {
    sdkMessages += 1
    const message = readSdkMessage(value)
    if (message === null) return NO_FRAMES
    lastMessage = message.type

    switch (message.type) {
      case "stream_event": {
        const event = readWireEvent(message.event)
        if (event === null) return NO_FRAMES
        lastEvent = event.type
        // A non-null `parent_tool_use_id` means a subagent produced this — a turn the client never
        // asked for. The envelope still sees it, so a filtered block loses its whole triple and its
        // numbering stays out of the answer's.
        return envelope.push(event, message.parentToolUseId)
      }
      case "system": {
        lastSystemSubtype = message.subtype
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
        sawResult = true
        // Frames folded in memory are not delivered bytes. Every actual failed result is an
        // error; the streaming response converts it to a terminal error after its first byte.
        if (message.isError) {
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
    if (step.done === true) return null
    const produced = handle(step.value)
    frames += produced.length
    return produced
  }

  let integrityReported = false
  const finish = (): readonly ClientFrame[] => {
    const terminal = envelope.finish(completion)
    frames += terminal.length
    if (!integrityReported && envelope.forcedBlockCloses > 0) {
      integrityReported = true
      observe(() =>
        input.observer?.onTruncatedTurn?.({
          blocks: envelope.forcedBlockCloses,
          kinds: envelope.forcedBlockKinds,
          lastMessage,
          lastEvent,
          sawResult,
          lastSystemSubtype,
          sdkMessages,
          frames,
        }),
      )
    }
    return terminal
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

    terminate(reason) {
      input.terminate?.(reason)
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
      // Failure/cancellation aborts before this close, settling any pending SDK read so the
      // generator's finally can run. Successful turns retain their normal gauge epilogue.
      iterator.return?.().catch(() => {})
    },
  }
}
