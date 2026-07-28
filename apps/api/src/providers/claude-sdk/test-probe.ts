import type { Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { createCliProbe } from "./cli-probe"
import type { SdkConcurrency, SdkSlot } from "./concurrency"
import { subprocessEnv } from "./env"
import { classifySdkFailure, readSdkFailure } from "./errors"
import { type CliResolution, resolveClaudeCli } from "./resolve-cli"

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
 *
 * **Nor is the concurrency gate** (`concurrency.ts`). It takes a slot from the *same* semaphore pair
 * the dispatch path takes one from, and the sharing is the point: the ceiling is a bound on how much
 * of this container's memory `claude` subprocesses may hold, and a bound that only one caller
 * honours is not a bound. `test-now.ts`'s cooldown is per Account, so it stops nobody from pressing
 * the button on ten Accounts at once — ungated, that is ten ~245 MB processes past a ceiling of
 * whatever the operator configured, which is the OOM the gate exists to prevent
 * (docs/idea/11-anthropic-agent-sdk.md §9).
 *
 * A probe queues behind live traffic rather than the other way around, and never displaces it: a
 * request a client is waiting on outranks a button an operator pressed, and the wait ends at the
 * probe's own deadline with a sentence naming the ceiling.
 */

export interface SdkTestProbeInput {
  /** Which Account this probe runs as — its per-Account subprocess slot is taken under this id. */
  readonly accountId: string
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
  /**
   * Every `rate_limit_info` this turn reported, oldest first, verbatim and unparsed.
   *
   * **The probe already paid for these.** It spawns a real subprocess and bills a real turn, and
   * the SDK volunteers the account's window state on *every* query — not only near a limit. Reading
   * the answer and dropping it meant the one button an operator presses to ask "how is this account
   * doing" spent a turn and learned nothing about quota, while the dispatch path
   * (`services/dataplane/sdk-attempt.ts`) folded the identical event into Account state. Same event,
   * same destination; the caller ingests it through the same store.
   *
   * Unparsed on purpose, exactly like `SdkInvokeOptions.onRateLimit`: this module knows how to spawn
   * a subprocess, not what a quota window means. `claude-sdk/quota.ts` owns that, and one parser is
   * the reason both transports agree.
   */
  readonly rateLimitInfos: readonly unknown[]
  /**
   * What the upstream *actually said*, verbatim and truncated — present only on a failure, and
   * **only ever for a log line**.
   *
   * {@link message} is router-authored by contract, which is right for a response body and useless
   * for the one case that matters: an upstream failing for a reason this build has no rule for
   * renders as "a reason this router does not recognize", and without this field the only copy of
   * the real text is the one we discarded. That is a dead end both for the operator and for
   * whoever has to write the missing rule — logging the sanitized message instead just records the
   * router's own words for "I could not classify this".
   *
   * Safe to log, not safe to return: the log redactor strips credential material
   * (`logging/redact.ts`), while a response body is a contract with the console.
   */
  readonly reasonDetail?: string
}

export interface SdkTestProbe {
  run(input: SdkTestProbeInput): Promise<SdkTestProbeResult>
}

/** What the probe asks for. Fixed, because the point is "did this credential answer", not a prompt. */
const PROBE_PROMPT = "Reply with exactly one word: pong"
const MESSAGE_SNIPPET_LIMIT = 200

/**
 * Router-authored, and it names the knob rather than the symptom: "timed out" would send an operator
 * looking at their subscription, when what happened is that this replica is already running every
 * `claude` process it is allowed to.
 */
const AT_CEILING =
  "this router is already running its maximum number of claude subprocesses (CLAUDE_SDK_MAX_CONCURRENCY) — the test gave up waiting for a slot"

/** The SDK's own entry point as this module calls it: one fixed string in, messages out. */
export type SdkProbeQueryFn = (params: {
  prompt: string
  options: Options
}) => AsyncIterable<SDKMessage>

export interface SdkTestProbeOptions {
  /** `CLAUDE_CLI_PATH`, validated at the env boundary. Re-resolved per call — see `resolve-cli.ts`. */
  readonly cliPathOverride: string | null
  /**
   * The replica's subprocess ceiling — the **same instance** the dispatch path holds, never a second
   * one sized the same. Two gates over one memory budget bound twice what the operator configured.
   */
  readonly concurrency: SdkConcurrency
  /** Injected in tests. Defaults to the real ladder over this host's filesystem. */
  readonly resolveCli?: () => CliResolution
  /** Injected in tests, for the reason `SdkInvokerDeps.runQuery` is: no test may spawn a `claude`. */
  readonly runQuery?: SdkProbeQueryFn
}

export function createSdkTestProbe(options: SdkTestProbeOptions): SdkTestProbe {
  const runQuery = options.runQuery ?? ((params) => query(params))
  const resolveCli =
    options.resolveCli ??
    (() => resolveClaudeCli(createCliProbe({ override: options.cliPathOverride })))

  return {
    async run(input) {
      // Resolved before a slot is taken: a router with no binary answers immediately, rather than
      // occupying capacity a live request could have used in order to discover it cannot spawn.
      const resolution = resolveCli()
      if (!resolution.ok) {
        return {
          ok: false,
          message: "this router has no usable claude binary to spawn — see /readyz",
          // Nothing spawned, so nothing was reported. Empty, never absent: a caller folding
          // readings in must not have to distinguish "no events" from "this path forgot".
          rateLimitInfos: [],
        }
      }

      let slot: SdkSlot
      try {
        slot = await options.concurrency.acquire(input.accountId, input.signal)
      } catch {
        // The only way out of the queue other than a slot is the caller's own signal, and the probe
        // is that caller. Nothing spawned, so there is nothing to report but the ceiling.
        return { ok: false, message: AT_CEILING, rateLimitInfos: [] }
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

      const rateLimitInfos: unknown[] = []

      try {
        for await (const message of runQuery({ prompt: PROBE_PROMPT, options: sdkOptions })) {
          // Collected before the result is examined, because a turn that ends in a spent window
          // still reported that window on its way there — and that reading is the whole answer to
          // "why did this fail". The SDK's own snake_case field, read here rather than through
          // `render/events.ts`: this loop consumes the SDK's messages directly, not the normalized
          // stream the dispatch path builds.
          if (message.type === "rate_limit_event") {
            rateLimitInfos.push(message.rate_limit_info)
            continue
          }
          if (message.type !== "result") continue
          if (message.subtype === "success" && !message.is_error) {
            return { ok: true, message: snippet(message.result), rateLimitInfos }
          }
          return {
            ok: false,
            message: resultFailureMessage(message),
            rateLimitInfos,
            ...detailOf(statedResult(message)),
          }
        }
        return {
          ok: false,
          message: "the Claude Agent SDK ended without answering",
          rateLimitInfos,
        }
      } catch (error) {
        return {
          ok: false,
          message: classifySdkFailure(error).clientMessage,
          rateLimitInfos,
          ...detailOf(readSdkFailure(error).message),
        }
      } finally {
        input.signal.removeEventListener("abort", onAbort)
        // The subprocess dies with the iterator, so the slot is free the moment this scope is:
        // holding it past the answer would shrink the ceiling by one for every probe ever run.
        slot.release()
      }
    },
  }
}

/**
 * What a failed turn actually says, in one sentence an operator can act on.
 *
 * **`subtype` alone is not the reason, and on the most important failure it is actively wrong.** A
 * spent Claude subscription comes back as `subtype: "success"` with `is_error: true` and the reason
 * in `result` — so rendering the subtype produced the self-contradiction "the Claude Agent SDK turn
 * did not succeed (success)" while discarding the one field that explained it. Observed on a live
 * account whose window was at 100%.
 *
 * So `result` leads, through the same `classifySdkFailure` table the dispatch path uses: a usage
 * limit reads as "the account's Claude subscription window is spent", an expired credential as
 * "needs re-authenticating", and each keeps the wording the client would have received, so the
 * button and the data plane never describe one condition two ways. A turn that failed with nothing
 * quotable falls back to the subtype, which is at least honest for `error_max_turns` and friends.
 */
/**
 * Absent rather than empty when the upstream said nothing — there is no detail to record.
 *
 * Takes the message rather than the field for the same reason {@link resultFailureMessage} does:
 * only the SDK's *success* result variant declares `result`, and the failure we care most about
 * (`subtype: "success"` with `is_error: true`) is that variant. A structurally-typed parameter
 * reads it off either without narrowing the union by hand.
 */
function detailOf(stated: string | undefined): { reasonDetail?: string } {
  const trimmed = stated?.trim()
  if (trimmed === undefined || trimmed === "") return {}
  return { reasonDetail: snippet(trimmed) }
}

/**
 * The `result` text, read off whichever result variant carries one — only the SDK's *success*
 * variant declares it, and the failure that matters most (`subtype: "success"` with
 * `is_error: true`) is that variant.
 *
 * `subtype` is in the parameter type purely to make this assignable: a shape whose properties are
 * all optional is a *weak type*, and the error variant — which has no `result` at all — shares no
 * property with it and is rejected. One field both variants declare is enough to anchor it.
 */
function statedResult(message: {
  readonly subtype: string
  readonly result?: string
}): string | undefined {
  return message.result
}

function resultFailureMessage(message: {
  readonly subtype: string
  readonly result?: string
}): string {
  const stated = message.result?.trim()
  if (stated !== undefined && stated !== "") return classifySdkFailure(stated).clientMessage
  return `the Claude Agent SDK turn did not succeed (${message.subtype})`
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
