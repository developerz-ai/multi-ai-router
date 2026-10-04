import { UpstreamTimeoutError } from "@multi-ai-router/core"

/**
 * Two clocks, and the reason there have to be two.
 *
 * A streaming response keeps its connection open by writing a `: ping` comment every 15 s. That
 * works — and it is exactly what makes a stalled subprocess invisible: the client's own idle timer
 * keeps resetting, so a `query()` that stopped producing anything an hour ago still looks alive from
 * the far end. **Our heartbeat hides the upstream's silence**, so a second, independent clock has to
 * watch the thing the heartbeat is covering for
 * (docs/idea/11-anthropic-agent-sdk.md §6 and §9, `streamIdleGuard.ts`).
 *
 * Hence the split, and it is not symmetric:
 *
 * - The **upstream idle guard** races every `next()`. It measures silence from the subprocess, and
 *   its expiry is a `504` — the attempt failed, and saying so is the only honest close.
 * - The **client heartbeat** runs continuously from the moment the stream opens, and is reset by a
 *   *write*, not by an SDK message. That distinction is the bug this shape avoids: most SDK
 *   messages produce no client bytes at all — a subagent's whole turn, every `rate_limit_event`,
 *   every intermediate `message_stop` — so a heartbeat rearmed on "an SDK message arrived" would go
 *   quiet for minutes while the router was busy dropping frames.
 *
 * Timers are injected. A test that had to wait 90 s for the guard would never be run, and one that
 * waited 90 ms would be flaky; `Ticker` makes both deterministic without a mock
 * (CLAUDE.md testing rules: inject the clock, never `mock()`).
 */

export interface StreamPacing {
  /** Upstream silence after which the attempt is a `504`. */
  readonly idleMs: number
  /** Client silence after which a `: ping` goes out. Zero disables the heartbeat entirely. */
  readonly heartbeatMs: number
}

/**
 * Meridian's numbers, and they are a pair rather than two independent knobs: the heartbeat has to
 * be comfortably shorter than any proxy's read timeout, and the guard comfortably longer than the
 * slowest legitimate gap between SDK messages — a long tool-free thinking stretch, or a cold model
 * start. Injected at every call site so the composition root can widen either from config.
 *
 * "Any proxy" includes the router's own listener. `Bun.serve` closes a connection that carries no
 * bytes for `idleTimeout` seconds — 10 by default, on a 4 s sweep — and 15 s of heartbeat cadence
 * is outside that: the socket died before the first ping went out, and the turn with it
 * (2026-09-07, every stream failure on the fleet on that 4 s grid). `SERVER_IDLE_TIMEOUT_SECONDS`
 * now sets the listener's clock, and `test/unit/listen.test.ts` keeps this cadence inside it.
 */
export const DEFAULT_STREAM_PACING: StreamPacing = { idleMs: 90_000, heartbeatMs: 15_000 }

export interface Ticker {
  /** Runs `fn` after `delayMs`. @returns a cancel function; calling it twice is harmless. */
  after(delayMs: number, fn: () => void): () => void
  /**
   * Monotonic milliseconds. Optional: without it a deadline is never judged late, and the guard
   * behaves exactly as an on-time timer would.
   */
  now?(): number
  /** Lets pending socket/pipe reads run. Optional; defaults to two `setImmediate` turns. */
  yieldToIo?(): Promise<void>
}

/**
 * Two immediates, not one: under Bun a single `setImmediate` can resume before the I/O poll, and
 * the poll is the thing being waited for (Meridian's independent-process socket probe, #1222).
 */
function yieldTwoImmediates(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
}

/** Timers that never hold the process open — a pending ping is not a reason to stay alive. */
export const systemTicker: Ticker = {
  after(delayMs, fn) {
    const handle = setTimeout(fn, delayMs)
    handle.unref?.()
    return () => clearTimeout(handle)
  },
  now: () => performance.now(),
  yieldToIo: yieldTwoImmediates,
}

/**
 * How far past its deadline the idle timer may fire before the lateness is read as a blocked event
 * loop rather than jitter. A blocked loop runs expired timers *before* the I/O poll that would
 * deliver bytes the upstream sent meanwhile, so without this a live stream is failed as silent.
 * Crossing it buys one I/O turn — never a longer window, and never for a liveness-only message
 * (Meridian #1222, `IDLE_DEADLINE_LATE_MS`).
 */
export const IDLE_DEADLINE_LATE_MS = 2_000

export interface IdleGuardInput {
  readonly pacing: StreamPacing
  /** Defaults to real timers. */
  readonly ticker?: Ticker
  /** Writes the keep-alive comment. Never called after `close()`; a throw is swallowed. */
  readonly onHeartbeat?: () => void
}

export interface IdleGuard {
  /**
   * Races `pending` against the upstream idle window that is currently open.
   *
   * The window is opened by the first race after {@link IdleGuard.progress} and stays open across
   * races until the next one: a read that returns only transport liveness — a wire `ping`, an SDK
   * `keep_alive` — does not buy another `idleMs`. That is the stall it would otherwise hide: a model
   * that has stopped producing anything while its connection keeps pinging (Meridian #1177).
   *
   * @throws UpstreamTimeoutError — a `504` — when the window closes with nothing from the model.
   * The pending promise is *not* cancelled here: terminating the subprocess is the abort signal's
   * job, and this guard only decides that waiting longer is not honest.
   */
  race<T>(pending: Promise<T>): Promise<T>
  /** The model produced something real. The next race opens a fresh window. */
  progress(): void
  /** Client bytes went out. Restarts the keep-alive clock. */
  wrote(): void
  /** Stops both clocks. Idempotent, and safe to call from a `finally`. */
  close(): void
}

const IDLE_MESSAGE =
  "the Claude Agent SDK produced nothing for the upstream idle window: the subprocess stalled"

/** One open idle window. `expired` resolves when its timer runs; `lateMs` says how late it ran. */
interface IdleWindow {
  readonly expired: Promise<void>
  readonly cancel: () => void
  lateMs: number
  /** The one I/O turn a late deadline buys is spent once per window, not once per read. */
  graceSpent: boolean
}

const IDLE: unique symbol = Symbol("idle")

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.ok) return outcome.value
  throw outcome.error
}

export function createIdleGuard(input: IdleGuardInput): IdleGuard {
  const ticker = input.ticker ?? systemTicker
  const { idleMs, heartbeatMs } = input.pacing

  let closed = false
  let cancelBeat: (() => void) | null = null
  let window: IdleWindow | null = null

  const beat = (): void => {
    if (closed) return
    // Rearmed before the write, so a heartbeat that throws costs one ping rather than the pacing.
    armBeat()
    try {
      input.onHeartbeat?.()
    } catch {
      // A broken keep-alive degrades this response. It does not stop the stream.
    }
  }

  const armBeat = (): void => {
    cancelBeat?.()
    cancelBeat =
      heartbeatMs > 0 && input.onHeartbeat !== undefined ? ticker.after(heartbeatMs, beat) : null
  }

  const openWindow = (): IdleWindow => {
    const dueAt = ticker.now === undefined ? null : ticker.now() + idleMs
    let fire = (): void => {}
    const expired = new Promise<void>((resolve) => {
      fire = resolve
    })
    const opened: IdleWindow = { expired, cancel: () => {}, lateMs: 0, graceSpent: false }
    const cancel = ticker.after(idleMs, () => {
      if (dueAt !== null && ticker.now !== undefined) opened.lateMs = ticker.now() - dueAt
      fire()
    })
    return Object.assign(opened, { cancel })
  }

  const closeWindow = (): void => {
    window?.cancel()
    window = null
  }

  armBeat()

  return {
    async race<T>(pending: Promise<T>): Promise<T> {
      if (closed || idleMs <= 0) return pending
      window ??= openWindow()
      const current = window

      let outcome: Outcome<T> | null = null
      const settled = pending.then(
        (value): Outcome<T> => {
          outcome = { ok: true, value }
          return outcome
        },
        (error: unknown): Outcome<T> => {
          outcome = { ok: false, error }
          return outcome
        },
      )
      const first = await Promise.race([settled, current.expired.then((): typeof IDLE => IDLE)])
      if (first !== IDLE) return unwrap(first)

      if (current.lateMs > IDLE_DEADLINE_LATE_MS && !current.graceSpent) {
        current.graceSpent = true
        await (ticker.yieldToIo ?? yieldTwoImmediates)()
        // A narrowing the closure assignment above hides from the compiler.
        const late = outcome as Outcome<T> | null
        if (late !== null) return unwrap(late)
      }
      throw new UpstreamTimeoutError(IDLE_MESSAGE)
    },

    progress() {
      closeWindow()
    },

    wrote() {
      if (closed) return
      armBeat()
    },

    close() {
      closed = true
      cancelBeat?.()
      cancelBeat = null
      closeWindow()
    },
  }
}
