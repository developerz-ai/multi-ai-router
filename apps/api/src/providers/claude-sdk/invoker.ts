import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { UpstreamAdmissionRefused } from "../upstream-admission"
import { createCliProbe } from "./cli-probe"
import type { SdkConcurrency } from "./concurrency"
import { ALWAYS_FRESH, type CredentialFreshness } from "./credential-freshness"
import { classifySdkFailure } from "./errors"
import { FORCED_TOOL_UNMET } from "./failure-rules-request"
import type { SdkInvocation, SdkInvoker } from "./invoke"
import { createQueryLaunch, type QueryLaunch } from "./options"
import { type OwnerLaunchFactory, ownedQuery } from "./owned-query"
import { buildSdkPrompt } from "./prompt"
import type { IgnoredOption } from "./reasoning"
import { renderSdkResponse, type StreamPacing, type Ticker } from "./render"
import { readSdkRequest } from "./request"
import { type CliResolution, resolveClaudeCli } from "./resolve-cli"
import { createPassthrough, type Passthrough } from "./tools"
import { admitTurn, type TurnAdmission } from "./turn-admission"
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
 * 1. **Read the body** (`request.ts`) — prompt, tools, system prompt, and response shape from one
 *    parse here (with a session store wired, `sdk-attempt.ts` also reads the conversation once).
 * 2. **Resolve the binary** (`resolve-cli.ts`) before anything is spawned, so a deployment with no
 *    usable `claude` fails as a router misconfiguration rather than as a mysterious subprocess death.
 * 3. **Admit the turn** (`turn-admission.ts`) — refresh-window claim, slot, re-entrant recheck.
 * 4. **Register the client's tools** (`tools/`) — only if it sent any, and registering widens
 *    nothing: `allowlist.ts` still decides what may execute, which is nothing (§7).
 * 5. **Launch** (`options.ts`) — isolation flags, the abort bridge, and the lineage plan verbatim.
 * 6. **Render** (`render/`) — SDK messages back into Anthropic Messages, streaming or not.
 * 7. **Gauge** (`usage-gauge.ts`) — once the first content frame is out, ask the query object for
 *    the plan's usage percentages, off the response path; `turn-lifecycle.ts` keeps the subprocess
 *    alive for exactly that long after `result`.
 *
 * Three lifetimes are managed here and nowhere else:
 *
 * - **The admission** (slot + claims) is held until the subprocess is finished with — never released
 *   early by a throw between acquire and launch, nor when `query()` returns. Every failure hands it
 *   back, because a leaked permit is invisible until the fourth one wedges the account.
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
 * with `forkSession: true` (same account, full history inherited) is legal under "never retry after
 * bytes are on the wire". Once, and only for a `resume` plan; a fork that comes back busy is real.
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
  /** One subprocess across the token-refresh moment (`turn-admission.ts`). Absent: never waits. */
  readonly freshness?: CredentialFreshness
  /** `CLAUDE_CLI_PATH`, validated at the env boundary. Null leaves the resolution ladder to decide. */
  readonly cliPathOverride?: string | null
  /** Injected in tests. Defaults to the real ladder over this host's filesystem. */
  readonly resolveCli?: () => CliResolution
  readonly ownerLaunch?: OwnerLaunchFactory
  /** Injected in tests. Defaults to the Agent SDK's own `query()`. */
  readonly runQuery?: SdkQueryFn
  /**
   * Idle guard and keep-alive cadence (`CLAUDE_SDK_STREAM_IDLE_SECONDS`,
   * `CLAUDE_SDK_STREAM_HEARTBEAT_SECONDS`). Defaults to the renderer's own (90 s / 15 s).
   */
  readonly pacing?: StreamPacing
  /** Bound on closing a turn's SDK iterator (`CLAUDE_SDK_TEARDOWN_TIMEOUT_MS`, `turn-lifecycle.ts`). */
  readonly teardownMs?: number
  /** The held deny's ceiling (`CLAUDE_SDK_DENY_HOLD_SECONDS`). Defaults to `early-stop.ts`'s 60 s. */
  readonly denyHoldMs?: number
  readonly ticker?: Ticker
  /** The per-turn plan-usage reading. Absent: no gauge is asked; the console shows alarms only. */
  readonly usageGauge?: SdkUsageGauge
  /** A `thinking` / `effort` value dropped rather than refused (`reasoning.ts`). Debug-logged. */
  readonly onIgnoredOption?: (detail: IgnoredOption) => void
}

/** Misconfigured, not out of capacity: `unknown`, a `502` and a failover to the next Account. */
const NO_CLI =
  "no usable claude binary is installed on this router, so a Claude subscription account cannot be dispatched to — see /readyz for which resolution rung failed"

export function createSdkInvoker(deps: SdkInvokerDeps): SdkInvoker {
  const runQuery = deps.runQuery ?? ((params) => query(params))
  const override = deps.cliPathOverride ?? null
  const resolveCli = deps.resolveCli ?? (() => resolveClaudeCli(createCliProbe({ override })))
  // Cache only successful CLI resolution; a repaired mount can recover a previous failure.
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
    const gaugeObservation =
      invocation.usageGaugeObservation ?? deps.usageGauge?.capture(invocation.accountId)
    const request = readSdkRequest(invocation.body)
    for (const detail of request.ignored) deps.onIgnoredOption?.(detail)
    const cli = usableCli()
    const prompt = buildSdkPrompt({ messages: request.messages, plan: invocation.session })

    // Aborting while queued throws the signal's own reason: a deadline stays a deadline.
    const admit = () =>
      admitTurn(
        { freshness, concurrency: deps.concurrency },
        invocation.accountId,
        invocation.signal,
      )
    const first = await admit()

    /** One `query()` turn. Releases nothing on failure — the caller below owns the slot's end. */
    const attempt = async (busySessionFork: boolean, own: TurnAdmission): Promise<Response> => {
      const stderr = createStderrTail()
      // The passthrough's early stop kills the subprocess the launch owns: tied once both exist.
      let launch: QueryLaunch | null = null
      const passthrough: Passthrough | null = createPassthrough({
        tools: request.tools,
        toolChoice: request.toolChoice,
        abort: () => launch?.abort(),
        // The SDK's hook timeout is in whole seconds; rounding up never expires a hold early.
        ...(deps.denyHoldMs === undefined
          ? {}
          : { holdTimeoutSeconds: Math.ceil(deps.denyHoldMs / 1_000) }),
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
        thinking: request.thinking,
        effort: request.effort,
        ...(passthrough === null ? {} : { passthrough }),
      })
      const started = launch

      const report = createSessionReport(invocation.onSession)
      const held = holdPrompt(prompt)

      try {
        const messages = await ownedQuery({
          ...invocation,
          options: started.options,
          ownerLaunch: deps.ownerLaunch,
          run: (options) => runQuery({ prompt: held.prompt, options }),
        })
        // The gauge is asked of the query object itself — the SDK doing the request, inside this
        // Account's own config directory, with a credential this router never sees.
        const turn = observeTurn(
          messages,
          {
            onFirstContent: () =>
              deps.usageGauge?.observe(invocation.accountId, messages, gaugeObservation) ??
              Promise.resolve(),
            onAnswerEnd: report.fire,
            onSettled: held.release,
            onEnd: () => {
              started.detach()
              own.release()
            },
            onTeardownTimeout: () => started.abort(new Error("claude subprocess did not close")),
          },
          deps.teardownMs,
        )
        const filtered = passthrough === null ? turn : passthrough.filter(turn)

        const response = await renderSdkResponse({
          messages: filtered,
          model: invocation.model,
          stream: request.stream,
          terminate: (reason) => {
            held.release()
            started.abort(reason)
          },
          ...(deps.ticker === undefined ? {} : { ticker: deps.ticker }),
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
          throw new Error(FORCED_TOOL_UNMET)
        }

        return response
      } catch (error) {
        // The renderer only throws before a byte is on the wire, so this is still allowed to be a
        // real status — and a retry is still legal. The subprocess is terminated because nothing is
        // going to read it now, and the prompt released so the SDK's input loop ends with it.
        report.fire()
        held.release()
        started.abort(error)
        if (error instanceof UpstreamAdmissionRefused) throw error
        throw withStderr(error, stderr.tail())
      }
    }

    // From here every exit hands the permits back: the stream's own end via `onEnd`, and every
    // failure — including one thrown before the launch existed — via the handlers below. Each
    // admission's release is its own and idempotent, so the overlap with `onEnd` is safe.
    try {
      return await attempt(false, first)
    } catch (error) {
      first.release()
      if (
        invocation.beforeUpstreamStart?.singleStart !== true &&
        invocation.session.kind === "resume" &&
        classifySdkFailure(error).classification.kind === "busy-session"
      ) {
        // The retry takes its own claims and slot, queueing honestly behind whatever arrived in
        // between; the first attempt's late epilogue can only release the first admission.
        const retry = await admit()
        try {
          return await attempt(true, retry)
        } catch (retried) {
          retry.release()
          throw retried
        }
      }
      throw error
    }
  }
}

/** The one rung that won, as `resolve-cli.ts` reports it. */
type UsableCli = Extract<CliResolution, { ok: true }>
