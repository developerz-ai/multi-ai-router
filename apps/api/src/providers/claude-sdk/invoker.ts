import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { createCliProbe } from "./cli-probe"
import type { SdkConcurrency } from "./concurrency"
import { ALWAYS_FRESH, type CredentialFreshness } from "./credential-freshness"
import { classifySdkFailure } from "./errors"
import type { SdkInvocation, SdkInvoker } from "./invoke"
import { createQueryLaunch, type QueryLaunch } from "./options"
import { buildSdkPrompt } from "./prompt"
import { renderSdkResponse, type StreamPacing } from "./render"
import { readSdkRequest } from "./request"
import { type CliResolution, resolveClaudeCli } from "./resolve-cli"
import { createPassthrough, type Passthrough } from "./tools"
import { holdPrompt, observeTurn } from "./turn-lifecycle"
import { createSessionReport, createStderrTail, withStderr } from "./turn-support"
import type { SdkUsageGauge, SdkUsageGaugeSource } from "./usage-gauge"

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
 * 7. **Gauge** (`usage-gauge.ts`) — once the first content frame is out, ask the query object for
 *    the plan's usage percentages, off the response path; `turn-lifecycle.ts` keeps the subprocess
 *    alive for exactly that long after `result`.
 *
 * Three lifetimes are managed here and nowhere else, because this is the only module that holds all
 * three at once:
 *
 * - **The slot** is held from the instant it is granted until the subprocess is finished with —
 *   normally, by failure, or by a client that went away — never released early by a throw between
 *   acquire and launch, and never when `query()` returns, which is immediately and long before the
 *   answer. Everything after the acquire runs under a handler that hands the permits back on
 *   failure, because a leaked permit is invisible until the fourth one wedges the account for good
 *   (`concurrency.ts`: "every holder releases").
 * - **The abort bridge** is detached at the same moment, or a finished query keeps a listener on a
 *   signal that outlives it (§9).
 * - **The session report** is fired once, at the end, with whatever the SDK named. Before the end
 *   there is no assistant uuid to report, and reporting twice would write the row twice.
 *
 * **One recovery lives here: busy-session → retry as a fork.** The CLI refuses to resume a session
 * still registered as a running background agent (§9's table, `errors.ts` `busy-session`) — the
 * fate of two turns of one conversation dispatched concurrently, and routine under
 * `CLAUDE_CODE_SESSION_KIND: "bg"` (`env.ts`). That refusal is thrown before the subprocess streams
 * anything, and the renderer only ever throws before a byte is on the wire — so one in-place retry
 * with `forkSession: true` (same account, same slot, full history inherited) is legal under "never
 * retry after bytes are on the wire", and strictly better than failing over to a cold account and a
 * full transcript replay. Once, and only for a `resume` plan: a `fork` already forks, `fresh` can
 * never be busy, and a fork that comes back busy too is a real failure the chain should see.
 *
 * `query` and the CLI resolution are injected for the same reason `fetch` is injected on the HTTP
 * path: **no test may spawn a real `claude` CLI** (CLAUDE.md testing rules), and a transport that
 * can only be exercised by spawning one is a transport nobody can test.
 */

/**
 * What `query()` hands back, narrowed to what this module uses: the message stream, plus the one
 * control method the usage gauge asks — optional, so a test's plain async iterable still qualifies.
 */
export type SdkQueryStream = AsyncIterable<unknown> & SdkUsageGaugeSource

/** The SDK's own entry point, narrowed to what this module uses. */
export type SdkQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}) => SdkQueryStream

export interface SdkInvokerDeps {
  /** Bounds `claude` subprocesses, globally and per Account. Shared across every request. */
  readonly concurrency: SdkConcurrency
  /**
   * Lets one subprocess cross this Account's token-refresh moment alone (`credential-freshness.ts`).
   * Taken **before** the slot, the one order every spawn site uses. Optional so a deployment that
   * wires none behaves exactly as it did before the gate existed.
   */
  readonly freshness?: CredentialFreshness
  /** `CLAUDE_CLI_PATH`, validated at the env boundary. Null leaves the resolution ladder to decide. */
  readonly cliPathOverride?: string | null
  /** Injected in tests. Defaults to the real ladder over this host's filesystem. */
  readonly resolveCli?: () => CliResolution
  /** Injected in tests. Defaults to the Agent SDK's own `query()`. */
  readonly runQuery?: SdkQueryFn
  /** Idle guard and keep-alive cadence. Defaults to the renderer's own (90 s / 15 s). */
  readonly pacing?: StreamPacing
  /**
   * The per-turn plan-usage reading. Absent means no gauge is asked and the turn ends exactly as it
   * always did — a deployment that wires none simply keeps showing alarms instead of percentages.
   */
  readonly usageGauge?: SdkUsageGauge
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

  const freshness = deps.freshness ?? ALWAYS_FRESH

  return async (invocation: SdkInvocation): Promise<Response> => {
    const cli = usableCli()
    const request = readSdkRequest(invocation.body)
    const prompt = buildSdkPrompt({ messages: request.messages, plan: invocation.session })

    // Held before the subprocess exists and released when its output stream ends. Aborting while
    // queued throws the signal's own reason, which `runSdkAttempt` reads as the deadline it was.
    // `let`, because a busy-session retry ends the first attempt's slot and takes its own.
    // Before the slot, never after: a caller holding a subprocess budget while it waits for someone
    // else's refresh would be holding capacity it cannot use.
    await freshness.ensureFresh(invocation.accountId, invocation.signal)
    let slot = await deps.concurrency.acquire(invocation.accountId, invocation.signal)

    /** One `query()` turn. Releases nothing on failure — the caller below owns the slot's end. */
    const attempt = async (busySessionFork: boolean): Promise<Response> => {
      const stderr = createStderrTail()
      // The passthrough's early stop terminates the subprocess, and the launch is what owns that
      // ability — so the two are tied together after both exist rather than at construction.
      let launch: QueryLaunch | null = null
      const passthrough: Passthrough | null = createPassthrough({
        tools: request.tools,
        toolChoice: request.toolChoice,
        abort: () => launch?.abort(),
      })

      launch = createQueryLaunch({
        configDir: invocation.configDir,
        model: invocation.model,
        cliPath: cli.path,
        signal: invocation.signal,
        onStderr: stderr.push,
        session: invocation.session,
        ...(busySessionFork ? { busySessionFork: true } : {}),
        ...(request.system === null ? {} : { systemPrompt: request.system }),
        ...(passthrough === null ? {} : { passthrough }),
      })
      const started = launch

      const report = createSessionReport(invocation.onSession)
      const held = holdPrompt(prompt)

      try {
        const messages = runQuery({ prompt: held.prompt, options: started.options })
        // The gauge is asked of the query object itself — the SDK doing the request, inside this
        // Account's own config directory, with a credential this router never sees.
        const turn = observeTurn(messages, {
          onFirstContent: () =>
            deps.usageGauge?.observe(invocation.accountId, messages) ?? Promise.resolve(),
          onSettled: held.release,
          onEnd: () => {
            report.fire()
            started.detach()
            slot.release()
          },
        })
        const filtered = passthrough === null ? turn : passthrough.filter(turn)

        const response = await renderSdkResponse({
          messages: filtered,
          model: invocation.model,
          stream: request.stream,
          ...(deps.pacing === undefined ? {} : { pacing: deps.pacing }),
          observer: {
            onSession: report.session,
            onAssistantUuid: report.assistant,
            ...(invocation.onRateLimit === undefined
              ? {}
              : { onRateLimit: invocation.onRateLimit }),
            // Enriched here rather than in the renderer, which is pure and knows nothing about
            // tools: the launch is the only place that holds both halves at once.
            ...(invocation.onTruncatedTurn === undefined
              ? {}
              : {
                  onTruncatedTurn: (detail) =>
                    invocation.onTruncatedTurn?.({
                      ...detail,
                      declaredTools: request.tools.length,
                      passthrough: passthrough !== null,
                      flushedBlocks: passthrough?.integrity().flushedBlocks ?? 0,
                    }),
                }),
          },
        })

        // A non-streaming turn is fully drained before `renderSdkResponse` returns (§6: "no byte is
        // on the wire until the whole object is"), so `passthrough.captures` is settled here and a
        // throw is still a real status, not a body already on the wire. A forced `tool_choice` that
        // produced no captured call is the silent downgrade the acceptance criteria refuses: refuse
        // loudly instead of answering with the plain-text turn — but only on a turn that actually
        // *completed*: the renderer answers a turn that ended in an upstream `error` frame with that
        // error under a `502` (`render/stream.ts`) rather than throwing, and relabelling it
        // "forced-tool-unmet" would misname a rate limit or a crash as a compliance failure. The
        // refusal is not attempted on a streaming turn — a chosen v1 scope decision, not a technical
        // impossibility (docs/idea/11-anthropic-agent-sdk.md §7 item 9): a terminal SSE error frame
        // after `message_stop` would be implementable, but this issue does not build it.
        if (
          !request.stream &&
          response.status === 200 &&
          passthrough?.required &&
          passthrough.captures.length === 0
        ) {
          // The sentence's tail is load-bearing: `errors.ts` matches it to classify this refusal as
          // `server-error` — retryable on another account, never the client's fault.
          throw new Error("tool_choice forced a tool call, but the turn completed without one")
        }

        return response
      } catch (error) {
        // The renderer only throws before a byte is on the wire, so this is still allowed to be a
        // real status — and a retry is still legal. The subprocess is terminated because nothing is
        // going to read it now, and the prompt released so the SDK's input loop ends with it.
        report.fire()
        held.release()
        started.abort(error)
        throw withStderr(error, stderr.tail())
      }
    }

    // From here every exit hands the permits back: the stream's own end via `done`, and every
    // failure — including one thrown before the launch existed — via the handlers below. The
    // releases are once-guarded per slot (`concurrency.ts`), so the overlap with `done` is safe.
    try {
      return await attempt(false)
    } catch (error) {
      if (
        invocation.session.kind === "resume" &&
        classifySdkFailure(error).classification.kind === "busy-session"
      ) {
        // The first attempt's stream is over, so its slot is already handed back (or is, here).
        // The retry takes its own, queueing honestly behind whatever arrived in between.
        slot.release()
        await freshness.ensureFresh(invocation.accountId, invocation.signal)
        slot = await deps.concurrency.acquire(invocation.accountId, invocation.signal)
        try {
          return await attempt(true)
        } catch (retried) {
          slot.release()
          throw retried
        }
      }
      slot.release()
      throw error
    }
  }
}

/** The one rung that won, as `resolve-cli.ts` reports it. */
type UsableCli = Extract<CliResolution, { ok: true }>
