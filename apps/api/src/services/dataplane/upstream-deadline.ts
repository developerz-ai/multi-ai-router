import { systemTicker } from "../../providers/claude-sdk/render/idle-guard"

/**
 * The clocks on one **streamed** HTTP attempt. A non-streamed attempt keeps the single
 * `UPSTREAM_TIMEOUT_MS` deadline (`attemptDeadline`): its headers arrive only with the finished
 * completion, so a first-byte or idle clock would cut a healthy answer.
 *
 * - **first byte** — no response headers yet. Nothing has reached the client, so expiry is a
 *   `timeout` failure the chain fails over on; a hung upstream costs this window, not the total.
 * - **idle** — headers are in and bytes may be on the wire, so failover is over. Silence past the
 *   window aborts the upstream; the relayed body errors with a `TimeoutError`, which the relay
 *   records as `upstream_timeout` and the breaker counts. Honest, never a silent hang.
 * - **total** — the outer bound, separate so a long healthy generation is not cut by a clock sized
 *   for hangs.
 *
 * The idle clock re-arms lazily — one timestamp per read, one timer per window — so a chunk costs a
 * clock read, not a timer. The same split of clocks the Agent-SDK path has
 * (`providers/claude-sdk/render/idle-guard.ts`), whose `Ticker` shape this reuses for injection.
 */

export interface StreamDeadlines {
  /** `UPSTREAM_FIRST_BYTE_TIMEOUT_MS`: response headers must arrive within this. */
  readonly firstByteMs: number
  /** `UPSTREAM_IDLE_TIMEOUT_MS`: the longest silence between body chunks. */
  readonly idleMs: number
  /** `UPSTREAM_STREAM_TIMEOUT_MS`: the whole streamed attempt, headers to last byte. */
  readonly totalMs: number
}

/** Timers plus a monotonic clock. Injected in tests; `systemTicker` (unref'd timers) otherwise. */
export interface DeadlineClock {
  after(delayMs: number, fn: () => void): () => void
  now(): number
}

export type DeadlineKind = "first-byte" | "idle" | "total"

export interface UpstreamDeadline {
  /** The attempt's signal: any clock, or the client going away. */
  readonly signal: AbortSignal
  /** Response headers are in: the first-byte clock stops. */
  headersArrived(): void
  /** The success response, its body watched for silence. The idle clock starts here. */
  watch(response: Response): Response
  /** Stops every clock — for a path that ends without relaying a body. Idempotent. */
  release(): void
  /** Which clock fired, if one did. */
  expired(): DeadlineKind | undefined
}

const MESSAGES: Readonly<Record<DeadlineKind, string>> = {
  "first-byte": "upstream sent no response headers within the first-byte deadline",
  idle: "upstream stream went silent past the idle deadline",
  total: "upstream stream outlived its total deadline",
}

const SYSTEM_CLOCK: DeadlineClock = {
  after: systemTicker.after,
  now: () => performance.now(),
}

export function upstreamDeadline(input: {
  readonly stream: StreamDeadlines
  readonly client?: AbortSignal | undefined
  readonly clock?: DeadlineClock
}): UpstreamDeadline {
  const clock = input.clock ?? SYSTEM_CLOCK
  const { firstByteMs, idleMs, totalMs } = input.stream
  const controller = new AbortController()
  const signal =
    input.client === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, input.client])
  let fired: DeadlineKind | undefined
  let cancelFirstByte = (): void => {}
  let cancelIdle = (): void => {}
  let cancelTotal = (): void => {}
  /** Errors the watched body, once there is one. */
  let failBody = (_reason: unknown): void => {}

  const release = (): void => {
    cancelFirstByte()
    cancelIdle()
    cancelTotal()
    input.client?.removeEventListener("abort", release)
  }
  const fire = (kind: DeadlineKind): void => {
    if (fired !== undefined || signal.aborted) return
    fired = kind
    release()
    // `TimeoutError`, the name `AbortSignal.timeout` uses: `transportFailure` and the relay terminal
    // already read it as a timeout, so every clock lands on the same verdict path.
    const reason = new DOMException(MESSAGES[kind], "TimeoutError")
    controller.abort(reason)
    // Not left to the fetch implementation: the client's stream ends with this reason whether or
    // not the upstream body honours the abort.
    failBody(reason)
  }

  // A client already gone arms nothing: the signal is aborted and the fetch never starts.
  if (input.client?.aborted !== true) {
    input.client?.addEventListener("abort", release, { once: true })
    cancelTotal = clock.after(totalMs, () => fire("total"))
    cancelFirstByte = clock.after(firstByteMs, () => fire("first-byte"))
  }

  /**
   * Pulled, never pushed: the upstream is read only when the client asks for the next chunk, so
   * nothing is buffered (non-negotiable 8), and silence is measured only while the router is
   * actually waiting on the upstream. A slow client that stops reading is backpressure, not an
   * upstream stall — counting it would strike a healthy account's breaker.
   */
  const watchSilence = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
    const reader = body.getReader()
    let waitingSince: number | undefined
    const check = (): void => {
      const silent = waitingSince === undefined ? 0 : clock.now() - waitingSince
      if (silent >= idleMs) fire("idle")
      else cancelIdle = clock.after(idleMs - silent, check)
    }
    cancelIdle = clock.after(idleMs, check)
    let failed = false
    return new ReadableStream<Uint8Array>(
      {
        start(controller) {
          failBody = (reason) => {
            failed = true
            controller.error(reason)
            void reader.cancel(reason).catch(() => {})
          }
        },
        async pull(controller) {
          waitingSince = clock.now()
          const next = await reader.read().finally(() => {
            waitingSince = undefined
          })
          if (failed) return
          if (next.done) {
            release()
            controller.close()
          } else controller.enqueue(next.value)
        },
        cancel(reason) {
          release()
          return reader.cancel(reason)
        },
      },
      { highWaterMark: 0 },
    )
  }

  return {
    signal,
    headersArrived() {
      cancelFirstByte()
    },
    watch(response) {
      if (response.body === null || signal.aborted) {
        release()
        return response
      }
      return new Response(watchSilence(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    },
    release,
    expired: () => fired,
  }
}

/**
 * The upstream call is bounded, and a client that disconnects releases it immediately. The one
 * deadline of a non-streamed HTTP attempt (`UPSTREAM_TIMEOUT_MS`), and of an Agent-SDK attempt.
 *
 * Shared with the Agent-SDK path, where the same signal terminates the subprocess: a client that
 * goes away must never orphan one (docs/idea/11-anthropic-agent-sdk.md §9).
 */
export function attemptDeadline(timeoutMs: number, client: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return client === undefined ? timeout : AbortSignal.any([timeout, client])
}
