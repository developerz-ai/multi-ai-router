import type { Dialect } from "@multi-ai-router/core"
import type { FailureClassification, ProviderDriver, UpstreamFailureKind } from "../../providers"
import { createResponseFraming } from "../usage/response-framing"
import { protocolFailure, readResponseTerminal } from "../usage/response-terminal"

/**
 * A wall inside a `2xx`, read **before** the response is committed to the client.
 *
 * Some upstreams answer a wall with a success status: MiniMax a drained balance as `200` plus a
 * `base_resp` envelope, Anthropic-shaped streams an overload or a rate limit as `200` then
 * `event: error`, Codex `response.failed` after `response.created`. Relayed as a success, the
 * client got an error body under a `200`, the account was struck only once the relay settled, and
 * a healthy sibling was never asked. Until a byte reaches the client failover is still open, so the
 * front of the body is read here and a wall becomes the failure it is.
 *
 * **Only for a client that is not streaming.** That client sees nothing before the whole answer
 * exists, so holding the status line until the front of the body is read costs it nothing. A
 * streaming client is committed at the upstream's headers, as before: holding its status line
 * until a first event — which a reasoning upstream may not send for minutes — would trip the
 * server's idle timeout and a client's header timeout, so a wall in its stream stays in-stream.
 *
 * **What is read, and no more.** A stream is read to its first event that is not a preamble
 * (`message_start`, `response.created`, `response.in_progress` — they open a response and carry no
 * output; Codex answers a spent plan as `response.created` then `response.failed`). That event
 * decides: an error is a wall, anything else commits, and so does a keepalive comment. A JSON body
 * is read whole, because an envelope is only an envelope once complete. Either read stops at
 * `maxBytes` and commits: a wall is a small envelope, never a large one. The upstream's own clocks
 * bound the wait — the caller hands in the watched response.
 *
 * **Nothing is changed.** A committed response replays the bytes read, then the rest, pulled on
 * demand: byte for byte, unbuffered past the peek (non-negotiable 10). It adds no time to first
 * token: the bytes held are bytes that precede it.
 */

export type SuccessPeek =
  | { readonly kind: "clear"; readonly response: Response }
  | {
      readonly kind: "wall"
      readonly classification: FailureClassification
      /** The status a client is owed for this wall — never a `2xx`. */
      readonly status: number
      /** The error payload itself, as JSON: the envelope relayed when no router verdict outranks it. */
      readonly bodyText: string
    }

export interface SuccessPeekInput {
  readonly dialect: Dialect
  readonly driver: Pick<ProviderDriver, "classifyFailure" | "responseObservation">
  readonly maxBytes: number
  /**
   * Ends the peek: the attempt's own deadline and the client, plus the router abandoning the
   * request at shutdown. The upstream body is cancelled and the reason thrown.
   */
  readonly signal?: AbortSignal
}

/** Opens a response and carries no output: read past, so the event after it can still decide. */
const PREAMBLE: Readonly<Record<Dialect, readonly string[]>> = {
  anthropic: ["message_start"],
  "openai-chat": [],
  "openai-responses": ["response.created", "response.in_progress"],
}

/**
 * The status a wall answers with. A clock fixes `429`, a human `402`; an exhausted upstream with no
 * finer word is capacity, `503`. Total over the vocabulary, so a new kind is decided here.
 */
const WALL_STATUS: Readonly<Record<UpstreamFailureKind, number>> = {
  "rate-limited": 429,
  "credits-exhausted": 402,
  auth: 401,
  "invalid-request": 400,
  "model-unsupported": 404,
  "server-error": 503,
  "stale-session": 503,
  "busy-session": 503,
  "subprocess-crash": 503,
  unknown: 502,
}

/** The two calls the peek makes on a body reader, so both runtimes' reader types satisfy it. */
interface BodyReader {
  read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
}

type Verdict = "commit" | { readonly payload: unknown; readonly wall: FailureClassification }

export async function peekSuccess(
  response: Response,
  input: SuccessPeekInput,
): Promise<SuccessPeek> {
  if (response.body === null) return { kind: "clear", response }
  const reader: BodyReader = response.body.getReader()
  const held: Uint8Array[] = []
  let verdict: Verdict | undefined
  const framing = createResponseFraming({
    contentType: response.headers.get("content-type"),
    maximumBytes: input.maxBytes,
    payload(payload, event) {
      if (verdict !== undefined) return
      const wall = classifyPayload(input, response.headers, payload, event)
      if (wall !== null) verdict = { payload, wall }
      else if (!isPreamble(input.dialect, payload, event)) verdict = "commit"
    },
    done() {
      verdict ??= "commit"
    },
    unavailable() {
      verdict ??= "commit"
    },
  })

  const sse =
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "text/event-stream"
  const decoder = new TextDecoder()
  let partial = ""
  let read = 0
  let ended = false
  try {
    while (verdict === undefined) {
      const next = await readOrAbort(reader, input.signal)
      if (next.done) {
        ended = true
        framing.finish()
        break
      }
      held.push(next.value)
      read += next.value.byteLength
      framing.observe(next.value)
      // A keepalive comment (`: OPENROUTER PROCESSING`) is what a client's idle timer runs on.
      // Only a whole line counts: a chunk can split a data line anywhere, colons included.
      if (sse && verdict === undefined) {
        const lines = (partial + decoder.decode(next.value, { stream: true })).split(/\r?\n|\r/)
        partial = lines.pop() ?? ""
        if (lines.some((line) => line.startsWith(":"))) break
      }
      if (read > input.maxBytes) break
    }
  } catch (error) {
    // The upstream broke, a clock fired, or the request was abandoned inside the peek. Nothing was
    // relayed, so the attempt fails as a transport fault would and the chain decides what follows.
    void reader.cancel(error).catch(() => {})
    throw error
  }

  if (verdict !== undefined && verdict !== "commit") {
    void reader.cancel().catch(() => {})
    return {
      kind: "wall",
      classification: verdict.wall,
      status: WALL_STATUS[verdict.wall.kind],
      bodyText: JSON.stringify(verdict.payload),
    }
  }
  return {
    kind: "clear",
    response: new Response(replay(held, reader, ended), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  }
}

/**
 * The driver's own reading of a success payload first (MiniMax's `base_resp`, Codex's stream
 * codes), then the dialect's explicit error shape, worded into a kind by the driver's rules. An
 * explicit error no rule names is still an error: a retryable `server-error`.
 */
function classifyPayload(
  input: SuccessPeekInput,
  headers: Headers,
  payload: unknown,
  event: string | undefined,
): FailureClassification | null {
  const own = input.driver.responseObservation?.inspectPayload?.(payload, event) ?? null
  if (own !== null) return own
  const terminal = readResponseTerminal(input.dialect, payload, event)
  if (terminal.failure === null) return null
  return (
    input.driver.classifyFailure({ status: 200, headers, body: payload }) ??
    protocolFailure("protocol:explicit-error")
  )
}

function isPreamble(dialect: Dialect, payload: unknown, event: string | undefined): boolean {
  const type =
    typeof payload === "object" && payload !== null && "type" in payload
      ? (payload as { readonly type: unknown }).type
      : event
  return typeof type === "string" && PREAMBLE[dialect].includes(type)
}

function readOrAbort(
  reader: BodyReader,
  signal: AbortSignal | undefined,
): ReturnType<BodyReader["read"]> {
  if (signal === undefined) return reader.read()
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    reader
      .read()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
  })
}

/** The bytes the peek read, then the rest of the upstream, pulled only as the client reads. */
function replay(
  held: readonly Uint8Array[],
  reader: BodyReader,
  ended: boolean,
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const chunk = held[index]
        if (chunk !== undefined) {
          index += 1
          controller.enqueue(chunk)
          return
        }
        if (ended) {
          controller.close()
          return
        }
        const next = await reader.read()
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      },
      cancel(reason) {
        return ended ? undefined : reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}
