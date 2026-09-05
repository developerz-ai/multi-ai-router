import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { PromptBlock } from "./prompt"

/**
 * The two ends of one `query()` turn's life: the prompt that opens it, and the message stream whose
 * end closes it — pulled out of `invoker.ts` because the usage gauge (`usage-gauge.ts`) needs the
 * subprocess to outlive the client's answer by one bounded control request, and the rules for that
 * are worth stating on their own.
 *
 * **The prompt is held open until the turn is finished with.** The SDK closes the subprocess's
 * stdin the moment the prompt iterable ends (and the first `result` is in), and the CLI exits on
 * EOF — so a gauge asked for after `result` would race a dying process. Holding the one-message
 * prompt open until `release()` keeps the CLI waiting for input instead, alive and idle, for exactly
 * as long as the epilogue below needs. Released on every exit, or the SDK's input loop would wait
 * forever on a turn that is already over.
 *
 * **The consumer's stream ends at `result`, not at process exit.** `result` is the authoritative end
 * of a turn (`render/stream.ts`); nothing after it is rendered. Ending there means the client's last
 * frame goes out the moment the turn is over rather than when the subprocess happens to exit — and
 * it is what lets the gauge run *after* the answer without delaying a byte of it.
 *
 * **One epilogue, fire-and-forget, exactly once.** However the consumer let go — exhausted, ended at
 * `result`, returned early because the client hung up, or failed — the same sequence runs: wait for
 * a gauge already in flight (bounded by its own timeout), release the prompt, close the SDK
 * iterator so the subprocess is terminated, then `onEnd` (the slot, the abort bridge, the session
 * report). The slot is held through the gauge on purpose: a subprocess that is alive is a subprocess
 * the memory bound has to count.
 */

export interface HeldPrompt {
  readonly prompt: AsyncIterable<SDKUserMessage>
  /** Lets the prompt end. Idempotent. */
  release(): void
}

/**
 * The prompt, as the SDK's streaming input: one user message, then a hold.
 *
 * The structured form is used rather than a plain string because a string cannot carry an image,
 * and dropping the client's images would be a fidelity loss nothing forces on us (§6).
 */
export function holdPrompt(content: readonly PromptBlock[]): HeldPrompt {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const message: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: [...content] },
    parent_tool_use_id: null,
  }
  return {
    prompt: {
      async *[Symbol.asyncIterator]() {
        yield message
        await held
      },
    },
    release,
  }
}

export interface TurnObserver {
  /**
   * Called once, after the first content-bearing message has been handed on — so nothing here can
   * move time-to-first-token. Whatever it returns is awaited before the subprocess is ended.
   */
  onFirstContent(): Promise<void>
  /**
   * Runs once the turn has nothing left to ask of the subprocess — the place to release the held
   * prompt, so the SDK's own input loop ends before the iterator is closed under it. Must not throw.
   */
  onSettled(): void
  /** Runs exactly once, after the subprocess is finished with. Must not throw. */
  onEnd(): void
}

/** The SDK messages that mean the turn has started answering. */
function isContent(message: unknown): boolean {
  const type = (message as { type?: unknown } | null)?.type
  return type === "stream_event" || type === "assistant"
}

function isResult(message: unknown): boolean {
  return (message as { type?: unknown } | null)?.type === "result"
}

/** Wraps one turn's SDK stream in the lifecycle described above. */
export function observeTurn(
  source: AsyncIterable<unknown>,
  observer: TurnObserver,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: () => iterate(source, observer),
  }
}

async function* iterate(
  source: AsyncIterable<unknown>,
  observer: TurnObserver,
): AsyncGenerator<unknown> {
  const inner = source[Symbol.asyncIterator]()
  let inFlight: Promise<void> = Promise.resolve()
  let seenContent = false

  const epilogue = async (): Promise<void> => {
    try {
      await inFlight
    } catch {
      // A gauge's failure is its own; the turn's end is not conditional on it.
    }
    observer.onSettled()
    try {
      await inner.return?.()
    } catch {
      // A source that refuses to close is not this module's failure.
    }
    observer.onEnd()
  }

  try {
    for (;;) {
      const step = await inner.next()
      if (step.done) return
      yield step.value
      if (!seenContent && isContent(step.value)) {
        seenContent = true
        inFlight = observer.onFirstContent()
      }
      if (isResult(step.value)) return
    }
  } finally {
    void epilogue()
  }
}
