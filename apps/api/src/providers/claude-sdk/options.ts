import type { Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { isPermittedTool, PERMITTED_TOOLS, toolDenial } from "./allowlist"
import { QUERY_ENV_OVERRIDES, subprocessEnv } from "./env"
import { scrubSystemPrompt } from "./scrub"
import type { SessionPlan } from "./session"
import type { Passthrough } from "./tools"

/**
 * The `Options` one Agent SDK `query()` is launched with, and the abort wiring around it.
 *
 * Everything here is an isolation guarantee, a bound, or the abort path. None of it is tuning, and
 * several fields read like dead code precisely because their effect is an **absence** — deleting
 * one as cleanup re-opens the hole it closes (docs/idea/07-security.md#subprocess-isolation).
 *
 * | Field | Why it is not a default |
 * |---|---|
 * | `settingSources: []` | Omitted, the CLI loads this host's user, project, and local settings and pulls the **router's own `CLAUDE.md`** into the system prompt. That is one tenant's context — ours — entering another key holder's request: a cross-tenant leak, not clutter |
 * | `strictMcpConfig: true` | The same leak by the other door. Without it a project `.mcp.json`, user settings, or an on-disk agent's frontmatter can attach MCP servers this router never configured |
 * | `skills: []` | And the third. Omitted is *not* "skills off" — the CLI's own defaults still apply, and a skill is host-authored text injected into the model's context |
 * | `tools: []` | Not `disallowedTools`: a blocklist blocks *invocation* while leaving the ~25 k-token built-in catalog in every upstream payload. Only an empty base set elides it. It is also the second lock behind `allowlist.ts`, never the first |
 * | `allowedTools` + `canUseTool` | The allowlist, applied twice: as the auto-approval set, and as a deny-by-default gate on every call. `permissionMode: "dontAsk"` is the third, independent lock — a call that reaches neither is denied rather than parked on a prompt nobody is there to answer. Never `bypassPermissions`, which auto-approves *before* the callback and would make the gate decorative |
 * | `maxTurns` | The SDK is an autonomous agent with a 200-turn internal budget; we are a single-turn endpoint. After a denied tool call it still runs a fully billed "digest" turn, so the budget is what bounds the loop (§7) |
 * | `cwd` | Server-controlled. The client's own working directory does not exist on this host, and passing it fails the spawn with an error that reads like anything but the cause (§8) |
 * | `mcpServers` + `hooks` | Present only when the client sent tools. The server declares them so the model emits well-formed calls; the hook denies every one and hands it to the client (`tools/`). Neither grants execution — the allowlist above is still the only thing that can (§7) |
 * | `systemPrompt` | The **client's**, or nothing. Omitted, the SDK runs with no system prompt at all, which is what a client that sent none asked for; the Claude Code preset is a per-Account setting, never a substituted default (§8). The one edit it receives is `scrub.ts`, and it is not editorial: a competing harness's identity lines make Anthropic meter the turn as a third-party app and refuse it on every account in the pool |
 * | `resume` / `forkSession` / `resumeSessionAt` | The lineage plan, applied verbatim. `fresh` is the absence of all three, not a value of one (§4) |
 *
 * **The abort path is the reason this returns more than an object.** The SDK takes an
 * `AbortController`, the data plane produces an `AbortSignal` already composed from the attempt
 * deadline and the client's disconnect (`services/dataplane/attempt.ts`), so the two are bridged
 * with a listener — and a listener on a long-lived signal that outlives the query is a leak. Hence
 * `detach()`: a finished query drops the bridge, an abandoned one aborts through it. A client that
 * goes away must never orphan a subprocess (§9).
 */

/**
 * Turns the SDK's agent loop takes before it stops. Three or four: one to answer, one for the
 * digest turn that follows a denied tool call, and headroom for a second denial.
 *
 * A named constant rather than an operator knob on purpose. It is not capacity — it is the bound
 * that makes an autonomous agent behave as a single-turn endpoint, and moving it changes the
 * protocol we synthesize, not how much of it a deployment can afford.
 */
export const MAX_TURNS = 4

export interface QueryLaunchInput {
  /** The isolated `CLAUDE_CONFIG_DIR`. Also the subprocess's working directory. */
  readonly configDir: string
  /** The model after the Account's alias map. Passed through, never substituted. */
  readonly model: string
  /** Which `claude` binary to spawn — `resolveClaudeCli`'s answer, never the SDK's own guess. */
  readonly cliPath: string
  /** The attempt deadline composed with the client's disconnect. Aborting it kills the subprocess. */
  readonly signal: AbortSignal
  /** Receives the subprocess's stderr, whose tail is how an SDK failure is classified (§9). */
  readonly onStderr?: (chunk: string) => void
  /** What to inherit the child environment from. Defaults to `process.env`. */
  readonly inheritedEnv?: NodeJS.ProcessEnv
  /**
   * The client's own tools, registered on an in-process MCP server with no-op handlers, plus the
   * `PreToolUse` hook that denies and captures every call (`tools/`). Absent for a client that sent
   * no tools: a plain chat request must not carry the machinery that bounds a tool loop.
   *
   * It widens nothing. The registered tools are **not** added to `allowedTools`, so `canUseTool`
   * refuses them exactly as it refuses a built-in, and the MCP handler behind them does nothing if
   * both gates are somehow passed (docs/idea/07-security.md).
   */
  readonly passthrough?: Passthrough
  /**
   * The client's own system prompt, already flattened (`request.ts`). Absent leaves the option
   * unset, which is what a client that sent none asked for: the SDK's default is *no* system
   * prompt, and substituting the Claude Code preset would put ~28 KB of instructions the caller
   * never wrote into their turn — a per-Account setting at most, never a default
   * (docs/idea/11-anthropic-agent-sdk.md §8).
   *
   * Passed through verbatim but for the harness fingerprints `scrub.ts` removes, and a prompt that
   * is nothing but fingerprints is the same as none at all — see {@link systemPromptOption}.
   */
  readonly systemPrompt?: string | readonly string[]
  /**
   * Whether this turn rejoins an SDK session, and how. Applied verbatim: the decision is a pure
   * function over stored hashes (`session/lineage.ts`) and re-deriving it here would put one
   * correctness decision in two places. `fresh` sets nothing, because a session the SDK has never
   * held is the absence of these options rather than a value of them.
   */
  readonly session?: SessionPlan
  /**
   * Recovery for a `busy-session` refusal, applied to a `resume` plan only: the CLI refuses to
   * resume a session that is still registered as a running background agent ("is currently running
   * as a background agent" — the fate of two turns of one conversation dispatched concurrently, and
   * routine under `CLAUDE_CODE_SESSION_KIND: "bg"`, see `env.ts`). `forkSession: true` without a
   * rewind point resumes the same transcript at its tip under a **new** session id, so the retry
   * inherits full history instead of failing over to a cold account and a full replay (Meridian's
   * `busySessionFork` does the same). A `fork` plan already forks and gains nothing from this;
   * `fresh` resumes nothing and can never be busy.
   */
  readonly busySessionFork?: boolean
}

export interface QueryLaunch {
  /** Hand straight to `query({ prompt, options })`. */
  readonly options: Options
  /** Terminates the subprocess and drops the bridge. Idempotent. */
  abort(reason?: unknown): void
  /** Drops the bridge without aborting. Call once the query has ended, or the signal retains us. */
  detach(): void
}

export function createQueryLaunch(input: QueryLaunchInput): QueryLaunch {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(input.signal.reason)

  if (input.signal.aborted) controller.abort(input.signal.reason)
  else input.signal.addEventListener("abort", onAbort, { once: true })

  const detach = (): void => input.signal.removeEventListener("abort", onAbort)

  const options: Options = {
    abortController: controller,
    // Isolation. Each of these three is a distinct path from this host's state into a caller's
    // request; all three must be set explicitly, and none may be dropped as cleanup.
    settingSources: [],
    strictMcpConfig: true,
    skills: [],
    // Tools. The base set is empty and the allowlist decides the rest — see `allowlist.ts`.
    tools: [],
    allowedTools: [...PERMITTED_TOOLS],
    permissionMode: "dontAsk",
    canUseTool: permitOnlyAllowlisted,
    // Transport.
    cwd: input.configDir,
    // `QUERY_ENV_OVERRIDES` after the inherited environment, so no inherited value can win — the
    // claude.ai-connector door and the scratchpad block are isolation decisions (`env.ts`).
    env: {
      ...subprocessEnv({ configDir: input.configDir, inherited: input.inheritedEnv }),
      ...QUERY_ENV_OVERRIDES,
    },
    // Explicit, because the SDK's default is a *detection*: it spawns `bun cli.js` whenever
    // `process.versions.bun` exists, wherever `bun` may or may not be on the child's PATH
    // (Meridian query.ts pins `node` because embedded-Bun hosts broke on exactly that). Our image
    // ships Bun as the runtime — the router itself runs under it — so `bun` is the decision; the
    // point is that it is written here, not autodetected. Moot while the resolved `claude` is the
    // platform-native binary, load-bearing the day a resolution rung lands on a `cli.js`.
    executable: "bun",
    pathToClaudeCodeExecutable: input.cliPath,
    model: input.model,
    maxTurns: MAX_TURNS,
    // `stream_event` messages exist only under this flag, and they are the one SDK message type
    // whose payload reaches the client (§6). Unconditional, because the non-streaming answer is
    // assembled from the same events — one renderer, not one per response shape.
    includePartialMessages: true,
    ...(input.onStderr === undefined ? {} : { stderr: input.onStderr }),
    ...systemPromptOption(input.systemPrompt),
    ...sessionOptions(input.session, input.busySessionFork === true),
    ...(input.passthrough === undefined
      ? {}
      : { mcpServers: input.passthrough.mcpServers, hooks: input.passthrough.hooks }),
  }

  return {
    options,
    abort: (reason) => {
      detach()
      controller.abort(reason)
    },
    detach,
  }
}

/**
 * The three session fields, from the one plan that decided them.
 *
 * `fork` is `resume` plus a rewind point: the SDK re-reads the stored transcript up to the named
 * assistant message and continues under a **new** session id, which is exactly what an undo is —
 * the old branch stays where it was, so a client that undoes and redoes does not destroy the
 * history it may go back to (docs/idea/11-anthropic-agent-sdk.md §4).
 */
function sessionOptions(plan: SessionPlan | undefined, busyFork: boolean): Partial<Options> {
  if (plan === undefined || plan.kind === "fresh") return {}
  if (plan.kind === "resume") {
    // A busy-session retry forks at the tip: `forkSession` without `resumeSessionAt` re-reads the
    // whole stored transcript under a new session id, which is a warm resume of a session the CLI
    // refuses to re-enter directly. See `QueryLaunchInput.busySessionFork`.
    return busyFork
      ? { resume: plan.sdkSessionId, forkSession: true }
      : { resume: plan.sdkSessionId }
  }
  return { resume: plan.sdkSessionId, forkSession: true, resumeSessionAt: plan.resumeSessionAt }
}

/**
 * The `systemPrompt` field, or its absence — and the **one** place a system prompt crosses into the
 * Agent SDK, which is why the fingerprint scrub lives here rather than at the invoker's read of the
 * body. A harness's own identity lines make Anthropic meter this subscription request as a
 * third-party app and refuse it on every account in the pool; `scrub.ts` carries the measurement and
 * the reason each pattern is load-bearing.
 *
 * A prompt that scrubs down to nothing omits the option entirely, exactly as a client that sent no
 * system prompt does: the SDK's default is *no* system prompt, and an empty one is a different
 * thing to send.
 */
function systemPromptOption(prompt: string | readonly string[] | undefined): Partial<Options> {
  if (prompt === undefined) return {}
  const scrubbed = scrubSystemPrompt(prompt)
  if (scrubbed === null) return {}
  // The SDK takes a mutable array; ours is readonly, and a copy is cheaper than widening the type.
  return { systemPrompt: typeof scrubbed === "string" ? scrubbed : [...scrubbed] }
}

/**
 * The deny-by-default gate. Called before every tool execution, including names this build has
 * never heard of.
 *
 * Denies without interrupting: the model's next legal move is to emit the call for the **client**
 * to run, and killing the turn would take that away. Refusal is what matters, not how loudly.
 *
 * Never returns `null` — the SDK reads `null` as "the host answered out of band", and an accidental
 * one parks the tool call with no deadline.
 *
 * A future `PreToolUse` hook must not become the only gate: a hook's deny bypasses `canUseTool`
 * entirely, so it can add capture and hold semantics on top of this, never replace them.
 */
async function permitOnlyAllowlisted(toolName: string): Promise<PermissionResult> {
  if (isPermittedTool(toolName)) return { behavior: "allow" }
  return { behavior: "deny", message: toolDenial(toolName) }
}
