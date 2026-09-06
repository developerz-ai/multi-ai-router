import { readMessageFacts, readStopFacts, readUsage, type SdkUsage, type WireEvent } from "./events"
import {
  type ClientFrame,
  isRecord,
  normalizedStart,
  outputCounts,
  randomMessageId,
  stripContextManagement,
  synthesizedStart,
} from "./frames"
import { createBlockIndexMap, type Turn, withClientIndex } from "./index-map"

/**
 * One SDK agent loop in, **one** Anthropic message out.
 *
 * The SDK is an autonomous agent: it runs several internal turns, and each one emits a complete
 * Anthropic message sequence of its own — its own `message_start`, its own block numbering, its own
 * `message_delta` and `message_stop`. The client asked for a single completion and its parser
 * assumes exactly one. So this is a *funnel*, not a filter, and the three narrowings are the whole
 * module (docs/idea/11-anthropic-agent-sdk.md §6):
 *
 * - **Exactly one `message_start`**, from the first turn that produces one — or synthesized, if a
 *   turn produced content without one.
 * - **Intermediate `message_delta`s and `message_stop`s are dropped.** The SDK emits one pair per
 *   turn; a client that saw the first would stop reading and miss everything after the tool call.
 *   The last stop reason is remembered and stated once, at the end.
 * - **Exactly one `message_stop`**, after the loop, always terminal.
 *
 * **Nothing is ever fabricated.** A turn that produced no content ends as an empty completion with
 * whatever stop reason was actually reported — not a canned sentence, and not an invented
 * `end_turn` (§6: "A router must never fabricate model output"). A stop reason nobody stated is
 * `null`, which is what absence means everywhere else in this codebase.
 *
 * **Ids are constructed by us**, since none of the SDK's are the client's to see when a turn is
 * synthesized. `crypto.randomUUID` rather than a timestamp: Meridian's `msg_${Date.now()}` collides
 * under concurrency, which is the failure mode a shared router has and a single-user proxy does not.
 *
 * Frames come out as plain JSON objects rather than encoded SSE, because the same sequence has to
 * serve both response shapes — SSE for a streaming client, folded into one body for a
 * non-streaming one (`message.ts`). One state machine, two renderings, no chance of the two
 * disagreeing about where a block began.
 *
 * Pure apart from id generation. No clock, no I/O, and nothing here throws: once bytes are on the
 * wire a request fails honestly, and a malformed frame is worth dropping, never worth a crash.
 */

export type { ClientFrame } from "./frames"

const NO_FRAMES: readonly ClientFrame[] = []

/**
 * What a turn that stopped mid-block is answered with. Router-authored and safe to render: it names
 * the shape of the failure and nothing about the account, the session, or the SDK's own words
 * (docs/idea/07-security.md).
 */
const TRUNCATED_ERROR_TYPE = "api_error"
const TRUNCATED =
  "the upstream ended this turn while it was still writing, so the answer is incomplete"

export interface EnvelopeOptions {
  /** The model the client asked for — used only until the SDK names one, and if it never does. */
  readonly model: string
  /** Injected so a test can assert an exact id. Defaults to a CSPRNG-backed one. */
  readonly newId?: () => string
}

/** What the turn ended as, decided by the caller from the SDK's authoritative `result`. */
export interface Completion {
  /** Null when nothing stated one. Absence is reported as absence, never as `end_turn`. */
  readonly stopReason: string | null
  /** The authoritative counts. Null falls back to whatever the last `message_delta` stated. */
  readonly usage: SdkUsage | null
}

export interface Envelope {
  /** Whether a `message_start` has reached the client. */
  readonly started: boolean
  /** Whether the client has seen a terminal frame. Everything after one is dropped. */
  readonly terminated: boolean
  /** The message id the client was given, or null before `message_start`. */
  readonly id: string | null
  /**
   * A raw Anthropic wire event from a `stream_event` message.
   *
   * @param turn the message's `parent_tool_use_id`: null for the turn the client asked for, and a
   * subagent's id otherwise. A subagent's output never reaches the client — it is a conversation
   * nobody requested — but it is still routed through the index map, both so the whole
   * start/delta/stop triple is skipped together and so its own block numbering cannot collide with
   * the answer's.
   * @returns the client frames this event produced, in order. Never throws.
   */
  push(event: WireEvent, turn: Turn): readonly ClientFrame[]
  /** The SDK loop ended. @returns the terminal frames still owed. */
  finish(completion: Completion): readonly ClientFrame[]
  /** A classified failure. @returns one terminal `error` frame, after which nothing is emitted. */
  fail(type: string, message: string): readonly ClientFrame[]
  /**
   * Blocks `finish` had to close because the upstream never did. Zero in every healthy turn — the
   * force-close below keeps the client's parser sound, but a non-zero count means an upstream (or
   * a filter of ours) dropped a `content_block_stop`, and without this counter that regression is
   * only visible in user transcripts, never in our logs (`stream.ts` reports it to the observer).
   */
  readonly forcedBlockCloses: number
  /**
   * What those blocks were — `text`, `tool_use`, `thinking`. Diagnostics only, and the one fact
   * that separates "the answer was cut short" from "the client was handed a tool call with no
   * arguments": nothing routes on it, and `sdk-attempt.ts` puts it on the alarm's log line.
   */
  readonly forcedBlockKinds: readonly string[]
}

export function createEnvelope(options: EnvelopeOptions): Envelope {
  const newId = options.newId ?? randomMessageId
  const blocks = createBlockIndexMap()

  let started = false
  let terminated = false
  let id: string | null = null
  let model = options.model
  let stopReason: string | null = null
  let stopSequence: string | null = null
  let lastUsage: SdkUsage | null = null
  let forcedBlockCloses = 0
  const forcedBlockKinds: string[] = []

  /**
   * Field-wise, newest non-null value wins. The SDK splits one turn's counts across events —
   * `message_start` carries the input and cache counts, each `message_delta` the output count so
   * far — so replacing wholesale (the old behaviour) threw away input and cache on **every** turn
   * whose authoritative `result` never arrived. That is precisely the early-stopped tool-call turn
   * (`tools/early-stop.ts` synthesizes a result with no usage, by design), the dominant agent
   * traffic shape, and it under-reported input+cache in every UsageRecord it produced. Nothing is
   * invented: a count no event stated stays null, and `outputCounts` still omits it.
   */
  const mergeUsage = (usage: SdkUsage | null): void => {
    if (usage === null) return
    const held = lastUsage
    lastUsage =
      held === null
        ? usage
        : {
            input_tokens: usage.input_tokens ?? held.input_tokens,
            output_tokens: usage.output_tokens ?? held.output_tokens,
            cache_creation_input_tokens:
              usage.cache_creation_input_tokens ?? held.cache_creation_input_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? held.cache_read_input_tokens,
          }
  }

  const openStart = (out: ClientFrame[], event: WireEvent | null): void => {
    if (started) return
    started = true
    if (event === null) {
      id = newId()
      out.push(synthesizedStart(id, model))
      return
    }
    const facts = readMessageFacts(event.raw)
    id = facts.id ?? newId()
    model = facts.model ?? model
    out.push(normalizedStart(event.raw, id, model))
  }

  const push = (event: WireEvent, turn: Turn): readonly ClientFrame[] => {
    if (terminated) return NO_FRAMES
    const keep = turn === null
    const out: ClientFrame[] = []

    switch (event.type) {
      case "message_start":
        if (keep) {
          openStart(out, event)
          // The turn's input and cache counts live here and nowhere else on the stream — see
          // `mergeUsage`. A subagent's start is not the answer's bill, so `keep` gates this too.
          if (isRecord(event.raw.message)) mergeUsage(readUsage(event.raw.message.usage))
        }
        break

      case "content_block_start": {
        if (event.index === null) break
        // The block's own type travels with it, so a turn that ends mid-block can say *what* was
        // left open — a truncated `tool_use` is a different failure from a truncated `text`.
        const opened = isRecord(event.raw.content_block) ? event.raw.content_block.type : null
        const decision = blocks.start(
          turn,
          event.index,
          keep,
          typeof opened === "string" ? opened : undefined,
        )
        if (decision.kind === "drop") break
        // A block cannot precede the message that carries it, even when the SDK skipped the start.
        openStart(out, null)
        out.push(withClientIndex(event, decision.index))
        break
      }

      case "content_block_delta":
      case "content_block_stop": {
        if (event.index === null) break
        const decision =
          event.type === "content_block_stop"
            ? blocks.stop(turn, event.index)
            : blocks.block(turn, event.index)
        if (decision.kind === "forward") out.push(withClientIndex(event, decision.index))
        break
      }

      case "message_delta": {
        // Remembered, never forwarded: one turn's ending is not the response's.
        if (!keep) break
        const facts = readStopFacts(event.raw)
        if (facts.stopReason !== null) stopReason = facts.stopReason
        if (facts.stopSequence !== null) stopSequence = facts.stopSequence
        mergeUsage(readUsage(event.raw.usage))
        break
      }

      // An upstream error, already spelled in the Anthropic dialect. Forwarded verbatim because the
      // provider's own answer is the honest one, and terminal because Anthropic's `error` is.
      case "error":
        if (keep) {
          terminated = true
          out.push({ ...event.raw, type: event.type })
        }
        break

      // `message_stop` and `ping` are the SDK's per-turn bookkeeping and our own pacing
      // respectively; both are emitted here rather than forwarded. An event type this build does
      // not define is dropped — the envelope cannot place a frame it cannot interpret, and §6
      // already records that unknown upstream features do not survive this path.
      default:
        break
    }

    return out.map(stripContextManagement)
  }

  return {
    get started() {
      return started
    },
    get terminated() {
      return terminated
    },
    get id() {
      return id
    },
    get forcedBlockCloses() {
      return forcedBlockCloses
    },
    get forcedBlockKinds() {
      return [...forcedBlockKinds]
    },
    push,

    finish(completion) {
      if (terminated) return NO_FRAMES
      terminated = true
      const out: ClientFrame[] = []
      openStart(out, null)

      const stranded = blocks.openBlocks()
      for (const block of stranded) {
        forcedBlockCloses += 1
        forcedBlockKinds.push(block.type)
        out.push({ type: "content_block_stop", index: block.index })
      }

      const stated = completion.stopReason ?? stopReason

      // **A turn that ended mid-block *without ever saying why* did not finish, and must not be
      // spelled as though it had.**
      //
      // The blocks are still closed — a client's parser is owed sound framing whatever happened —
      // but what follows them is an `error`, not a `message_delta` and a `message_stop`. Those two
      // are the sentence "this is the whole answer", and it is not: the model was still speaking.
      //
      // Until 2.10.2 this path emitted the clean ending anyway, and the cost was paid by whoever
      // read the answer. A client got a truncated essay that looked complete, or — worse — a
      // `tool_use` block whose arguments never arrived, which is `arguments: ""` on the openai wire
      // and not parseable at all. The one component that knew the answer was broken was the only
      // one that said nothing about it: the router logged `sdk stream closed with unterminated
      // content blocks` and handed the client a normal completion (2026-09-06).
      //
      // Honest instead: the client sees a failure it can act on — retry the turn, rather than build
      // on half an answer — and, on a *non-streaming* turn, the error becomes a real status before
      // any byte is out, so the failover chain tries the next account instead of the caller ever
      // seeing it. `render/stream.ts` owns that half.
      //
      // The stop reason is what separates the two shapes, and only one of them is this failure. An
      // upstream that stated `end_turn` and merely dropped a `content_block_stop` sent a *whole*
      // answer with one framing event missing: that is repaired above and finishes cleanly, exactly
      // as it always did. An upstream that stopped without ever stating an ending was still writing,
      // and that is the shape production kept producing — two chunks, no `message_delta`, no
      // `result`, the stream simply over (2026-09-06).
      if (stranded.length > 0 && stated === null) {
        out.push({ type: "error", error: { type: TRUNCATED_ERROR_TYPE, message: TRUNCATED } })
        return out
      }

      out.push({
        type: "message_delta",
        delta: { stop_reason: stated, stop_sequence: stopSequence },
        usage: outputCounts(completion.usage ?? lastUsage),
      })
      out.push({ type: "message_stop" })
      return out
    },

    fail(type, message) {
      if (terminated) return NO_FRAMES
      terminated = true
      return [{ type: "error", error: { type, message } }]
    },
  }
}
