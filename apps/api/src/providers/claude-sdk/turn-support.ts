import { STDERR_TAIL_LIMIT } from "./errors"
import type { SdkInvocation, SdkSessionReport } from "./invoke"

/**
 * The per-attempt bookkeeping `invoker.ts` wraps around one `query()` turn: the session report
 * fired once at the end, the bounded stderr tail, and the carrier that puts that tail where
 * `classifySdkFailure` looks for it. Split out so the invoker stays the file that only puts the
 * pieces in order — these three have no ordering of their own.
 */

export interface SessionReport {
  session(sdkSessionId: string): void
  assistant(uuid: string): void
  /** Reports what the SDK named, once. A turn that never named a session reports nothing. */
  fire(): void
}

/**
 * The Session mapping's half of the turn.
 *
 * Fired at the end rather than on arrival: the session id lands in `system`/`init` before any
 * content, the assistant uuid only once the turn has produced one, and a binding written without
 * the uuid costs the next undo its fork point. Firing once also means one row write per turn rather
 * than one per message (`session/store.ts`).
 */
export function createSessionReport(onSession: SdkInvocation["onSession"]): SessionReport {
  let sdkSessionId: string | null = null
  let assistantUuid: string | null = null
  let fired = false

  return {
    session: (value) => {
      sdkSessionId = value
    },
    assistant: (value) => {
      assistantUuid = value
    },
    fire: () => {
      if (fired || onSession === undefined || sdkSessionId === null) return
      fired = true
      const report: SdkSessionReport = {
        sdkSessionId,
        ...(assistantUuid === null ? {} : { assistantUuid }),
      }
      // The caller's own bookkeeping. A throw here is theirs, and it must not become this turn's.
      try {
        onSession(report)
      } catch {
        // The binding is not recorded. The answer is already served, and the next turn is cold.
      }
    },
  }
}

export interface StderrTail {
  push(chunk: string): void
  /** The last {@link STDERR_TAIL_LIMIT} characters the subprocess wrote. */
  tail(): string
}

/** Bounded at the source: a crashing subprocess can print megabytes, and the cause is at the end. */
export function createStderrTail(): StderrTail {
  let buffered = ""
  return {
    push: (chunk) => {
      buffered = (buffered + chunk).slice(-STDERR_TAIL_LIMIT)
    },
    tail: () => buffered,
  }
}

/**
 * Attaches the subprocess's own last words to the failure, which is where `classifySdkFailure`
 * looks for them (`errors.ts`).
 *
 * Only ever *adds*: an error that already carries stderr keeps its own, and an abort or a deadline
 * is rethrown untouched so its `name` still reads as the deadline it was (`sdk-attempt.ts`).
 */
export function withStderr(error: unknown, tail: string): unknown {
  if (tail === "" || typeof error !== "object" || error === null) return error
  if (typeof Reflect.get(error, "stderr") === "string") return error
  if (!(error instanceof Error)) return error

  const carried = new SdkSubprocessError(error.message, tail)
  carried.name = error.name
  return carried
}

/** An SDK failure with the subprocess's stderr tail beside it. Never rendered to a client. */
class SdkSubprocessError extends Error {
  readonly stderr: string

  constructor(message: string, stderr: string) {
    super(message)
    this.name = "SdkSubprocessError"
    this.stderr = stderr
  }
}
