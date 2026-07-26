import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { createCliProbe } from "./cli-probe"
import type { SdkConcurrency } from "./concurrency"
import { STDERR_TAIL_LIMIT } from "./errors"
import type { SdkInvocation, SdkInvoker, SdkSessionReport } from "./invoke"
import { createQueryLaunch, type QueryLaunch } from "./options"
import { buildSdkPrompt, type PromptBlock } from "./prompt"
import { renderSdkResponse, type StreamPacing } from "./render"
import { readSdkRequest } from "./request"
import { type CliResolution, resolveClaudeCli } from "./resolve-cli"
import { createPassthrough, type Passthrough } from "./tools"

/**
 * The `SdkInvoker` itself: one Anthropic Messages request in, one `query()` turn, one Anthropic
 * Messages `Response` out (docs/idea/11-anthropic-agent-sdk.md §2, §6).
 *
 * Every piece it uses was built and tested on its own; this is the file that puts them in order,
 * and the order is the design:
 *
 * 1. **Read the body once** (`request.ts`) — prompt, tools, system prompt, and response shape all
 *    come out of one parse, because this path is the labeled exception to "never parse a passthrough
 *    body" and the exception is only affordable once.
 * 2. **Resolve the binary** (`resolve-cli.ts`) before anything is spawned, so a deployment with no
 *    usable `claude` fails as a router misconfiguration rather than as a mysterious subprocess death.
 * 3. **Take a slot** (`concurrency.ts`) — per-Account first, global second. A caller aborted while
 *    queued throws the signal's own reason, so a deadline stays a deadline.
 * 4. **Register the client's tools** (`tools/`) — only if it sent any, and registering widens
 *    nothing: `allowlist.ts` still decides what may execute, which is nothing (§7).
 * 5. **Launch** (`options.ts`) — isolation flags, the abort bridge, and the lineage plan verbatim.
 * 6. **Render** (`render/`) — SDK messages back into Anthropic Messages, streaming or not.
 *
 * Three lifetimes are managed here and nowhere else, because this is the only module that holds all
 * three at once:
 *
 * - **The slot** is released when the message stream ends — normally, by failure, or by a client
 *   that went away — never when `query()` returns, which is immediately and long before the answer.
 * - **The abort bridge** is detached at the same moment, or a finished query keeps a listener on a
 *   signal that outlives it (§9).
 * - **The session report** is fired once, at the end, with whatever the SDK named. Before the end
 *   there is no assistant uuid to report, and reporting twice would write the row twice.
 *
 * `query` and the CLI resolution are injected for the same reason `fetch` is injected on the HTTP
 * path: **no test may spawn a real `claude` CLI** (CLAUDE.md testing rules), and a transport that
 * can only be exercised by spawning one is a transport nobody can test.
 */

/** The SDK's own entry point, narrowed to what this module uses. */
export type SdkQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}) => AsyncIterable<unknown>

export interface SdkInvokerDeps {
  /** Bounds `claude` subprocesses, globally and per Account. Shared across every request. */
  readonly concurrency: SdkConcurrency
  /** `CLAUDE_CLI_PATH`, validated at the env boundary. Null leaves the resolution ladder to decide. */
  readonly cliPathOverride?: string | null
  /** Injected in tests. Defaults to the real ladder over this host's filesystem. */
  readonly resolveCli?: () => CliResolution
  /** Injected in tests. Defaults to the Agent SDK's own `query()`. */
  readonly runQuery?: SdkQueryFn
  /** Idle guard and keep-alive cadence. Defaults to the renderer's own (90 s / 15 s). */
  readonly pacing?: StreamPacing
}

/**
 * A router with no usable `claude` binary is misconfigured, not out of capacity. It classifies as
 * `unknown` — a `502` and a failover to the next Account, which is the honest answer: this Account
 * could not be served and another transport in the same Pool may still serve the request.
 */
const NO_CLI =
  "no usable claude binary is installed on this router, so a Claude subscription account cannot be dispatched to — see /readyz for which resolution rung failed"

export function createSdkInvoker(deps: SdkInvokerDeps): SdkInvoker {
  const runQuery = deps.runQuery ?? ((params) => query(params))
  const override = deps.cliPathOverride ?? null
  const resolveCli = deps.resolveCli ?? (() => resolveClaudeCli(createCliProbe({ override })))
  // Resolution is a filesystem walk and its answer cannot change while the process runs — a binary
  // does not move under a live container. A *failed* resolution is not cached, so an operator who
  // fixes a mount recovers without a restart.
  let resolved: UsableCli | null = null

  const usableCli = (): UsableCli => {
    if (resolved !== null) return resolved
    const resolution = resolveCli()
    if (!resolution.ok) throw new Error(NO_CLI)
    resolved = resolution
    return resolution
  }

  return async (invocation: SdkInvocation): Promise<Response> => {
    const cli = usableCli()
    const request = readSdkRequest(invocation.body)
    const prompt = buildSdkPrompt({ messages: request.messages, plan: invocation.session })

    // Held before the subprocess exists and released when its output stream ends. Aborting while
    // queued throws the signal's own reason, which `runSdkAttempt` reads as the deadline it was.
    const slot = await deps.concurrency.acquire(invocation.accountId, invocation.signal)

    const stderr = createStderrTail()
    // The passthrough's early stop terminates the subprocess, and the launch is what owns that
    // ability — so the two are tied together after both exist rather than at construction.
    let launch: QueryLaunch | null = null
    const passthrough: Passthrough | null = createPassthrough({
      tools: request.tools,
      abort: () => launch?.abort(),
    })

    launch = createQueryLaunch({
      configDir: invocation.configDir,
      model: invocation.model,
      cliPath: cli.path,
      signal: invocation.signal,
      onStderr: stderr.push,
      session: invocation.session,
      ...(request.system === null ? {} : { systemPrompt: request.system }),
      ...(passthrough === null ? {} : { passthrough }),
    })
    const started = launch

    const report = createSessionReport(invocation.onSession)
    const done = (): void => {
      report.fire()
      started.detach()
      slot.release()
    }

    try {
      const messages = runQuery({ prompt: singleTurn(prompt), options: started.options })
      const filtered = passthrough === null ? messages : passthrough.filter(messages)

      return await renderSdkResponse({
        messages: untilExhausted(filtered, done),
        model: invocation.model,
        stream: request.stream,
        ...(deps.pacing === undefined ? {} : { pacing: deps.pacing }),
        observer: {
          onSession: report.session,
          onAssistantUuid: report.assistant,
          ...(invocation.onRateLimit === undefined ? {} : { onRateLimit: invocation.onRateLimit }),
        },
      })
    } catch (error) {
      // The renderer only throws before a byte is on the wire, so this is still allowed to be a
      // real status. The subprocess is terminated because nothing is going to read it now.
      started.abort(error)
      done()
      throw withStderr(error, stderr.tail())
    }
  }
}

/** The one rung that won, as `resolve-cli.ts` reports it. */
type UsableCli = Extract<CliResolution, { ok: true }>

/**
 * The prompt, as the SDK's streaming input.
 *
 * One user message, and the stream ends there: the SDK closes the subprocess's stdin once the
 * iterable is exhausted, which is what makes a single-turn endpoint out of a bidirectional
 * protocol. The structured form is used rather than a plain string because a string cannot carry an
 * image, and dropping the client's images would be a fidelity loss nothing forces on us (§6).
 */
async function* singleTurn(content: readonly PromptBlock[]): AsyncIterable<SDKUserMessage> {
  const message: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: [...content] },
    parent_tool_use_id: null,
  }
  yield message
}

/**
 * Runs `onEnd` exactly once, when the SDK's message stream is finished with — whether it ended, or
 * failed, or the renderer let go of it because the client did.
 *
 * A wrapper rather than a callback on the renderer, because the renderer's job is one turn's frames
 * and this is the request's resources. `finally` on a generator is the one construct that fires for
 * all three endings, including the one nobody writes a test for.
 */
async function* untilExhausted(
  messages: AsyncIterable<unknown>,
  onEnd: () => void,
): AsyncIterable<unknown> {
  try {
    for await (const message of messages) yield message
  } finally {
    onEnd()
  }
}

interface SessionReport {
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
function createSessionReport(onSession: SdkInvocation["onSession"]): SessionReport {
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

interface StderrTail {
  push(chunk: string): void
  /** The last {@link STDERR_TAIL_LIMIT} characters the subprocess wrote. */
  tail(): string
}

/** Bounded at the source: a crashing subprocess can print megabytes, and the cause is at the end. */
function createStderrTail(): StderrTail {
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
function withStderr(error: unknown, tail: string): unknown {
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
