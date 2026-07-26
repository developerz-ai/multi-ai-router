import type { Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { createCliProbe } from "./cli-probe"
import { subprocessEnv } from "./env"
import { classifySdkFailure } from "./errors"
import { resolveClaudeCli } from "./resolve-cli"

/**
 * The "Test now" button's Agent-SDK half: one real, billed `query()` turn against an Account's own
 * `CLAUDE_CONFIG_DIR`, so an operator can prove a Claude subscription actually answers before
 * pointing a tool at it.
 *
 * **Deliberately not `SdkInvoker` (`invoke.ts`).** That seam produces a `Response` re-synthesized
 * for a client on the data plane — sessions, streaming frames, tool passthrough, the works. A
 * diagnostic button needs none of it: no session to bind, no tools to grant, and the answer is a
 * boolean and a short sentence, not a wire body. Reusing the dispatch path here would mean carrying
 * its whole machinery for a button press that never streams to anyone.
 *
 * What is *not* skipped is every isolation guarantee `options.ts` documents at length:
 * `settingSources: []`, `strictMcpConfig: true`, an empty tool set, and a `canUseTool` that denies
 * everything. A probe is still a request running as the operator's own credential, and it gets the
 * same subprocess sandbox a real request does — CLAUDE.md non-negotiable 2, no exception for a
 * diagnostic.
 */

export interface SdkTestProbeInput {
  /** The isolated `CLAUDE_CONFIG_DIR` this Account's subprocess runs against. */
  readonly configDir: string
  /** The model after the Account's alias map. Passed through, never substituted. */
  readonly model: string
  readonly signal: AbortSignal
}

export interface SdkTestProbeResult {
  readonly ok: boolean
  /**
   * Router-authored, or the model's own one-word reply. Never a path, a session id, a credential,
   * or raw stderr — `classifySdkFailure`'s `clientMessage` is what carries a failure, by the same
   * contract the dispatch path renders to a client.
   */
  readonly message: string
}

export interface SdkTestProbe {
  run(input: SdkTestProbeInput): Promise<SdkTestProbeResult>
}

/** What the probe asks for. Fixed, because the point is "did this credential answer", not a prompt. */
const PROBE_PROMPT = "Reply with exactly one word: pong"
const MESSAGE_SNIPPET_LIMIT = 200

export interface SdkTestProbeOptions {
  /** `CLAUDE_CLI_PATH`, validated at the env boundary. Re-resolved per call — see `resolve-cli.ts`. */
  readonly cliPathOverride: string | null
}

export function createSdkTestProbe(options: SdkTestProbeOptions): SdkTestProbe {
  return {
    async run(input) {
      const resolution = resolveClaudeCli(createCliProbe({ override: options.cliPathOverride }))
      if (!resolution.ok) {
        return {
          ok: false,
          message: "this router has no usable claude binary to spawn — see /readyz",
        }
      }

      const controller = new AbortController()
      const onAbort = (): void => controller.abort(input.signal.reason)
      if (input.signal.aborted) controller.abort(input.signal.reason)
      else input.signal.addEventListener("abort", onAbort, { once: true })

      const sdkOptions: Options = {
        abortController: controller,
        // Isolation, identical to the dispatch path (`options.ts`) — a probe is a real request.
        settingSources: [],
        strictMcpConfig: true,
        skills: [],
        tools: [],
        allowedTools: [],
        permissionMode: "dontAsk",
        canUseTool: denyEveryTool,
        cwd: input.configDir,
        env: subprocessEnv({ configDir: input.configDir }),
        pathToClaudeCodeExecutable: resolution.path,
        model: input.model,
        // One turn: the probe asks one question and reads one answer, never an agent loop.
        maxTurns: 1,
        includePartialMessages: false,
      }

      try {
        for await (const message of query({ prompt: PROBE_PROMPT, options: sdkOptions })) {
          if (message.type !== "result") continue
          if (message.subtype === "success" && !message.is_error) {
            return { ok: true, message: snippet(message.result) }
          }
          return {
            ok: false,
            message: `the Claude Agent SDK turn did not succeed (${message.subtype})`,
          }
        }
        return { ok: false, message: "the Claude Agent SDK ended without answering" }
      } catch (error) {
        return { ok: false, message: classifySdkFailure(error).clientMessage }
      } finally {
        input.signal.removeEventListener("abort", onAbort)
      }
    },
  }
}

/** No tool this probe could grant — it asks one question and reads one answer. */
async function denyEveryTool(): Promise<PermissionResult> {
  return { behavior: "deny", message: "this probe grants no tools" }
}

function snippet(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= MESSAGE_SNIPPET_LIMIT
    ? trimmed
    : `${trimmed.slice(0, MESSAGE_SNIPPET_LIMIT)}…`
}
