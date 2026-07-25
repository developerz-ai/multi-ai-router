import type { Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { isPermittedTool, PERMITTED_TOOLS, toolDenial } from "./allowlist"
import { subprocessEnv } from "./env"
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
    env: subprocessEnv({ configDir: input.configDir, inherited: input.inheritedEnv }),
    pathToClaudeCodeExecutable: input.cliPath,
    model: input.model,
    maxTurns: MAX_TURNS,
    // `stream_event` messages exist only under this flag, and they are the one SDK message type
    // whose payload reaches the client (§6). Unconditional, because the non-streaming answer is
    // assembled from the same events — one renderer, not one per response shape.
    includePartialMessages: true,
    ...(input.onStderr === undefined ? {} : { stderr: input.onStderr }),
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
