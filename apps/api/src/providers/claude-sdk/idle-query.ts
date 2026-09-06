import type { Options, PermissionResult, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { PERMITTED_TOOLS } from "./allowlist"
import type { SdkConcurrency, SdkSlot } from "./concurrency"
import { ALWAYS_FRESH, type CredentialFreshness } from "./credential-freshness"
import { QUERY_ENV_OVERRIDES, subprocessEnv } from "./env"

/**
 * An Agent SDK `query()` that **never sends a turn**: the subprocess comes up, completes its
 * `initialize` handshake, and waits on a prompt stream that never yields until `close()`. What the
 * handshake makes available — `supportedModels()`, the usage gauge — can then be read off the query
 * object without a message ever reaching a model and without a token being billed.
 *
 * Why a module of its own: two readers want exactly this and nothing else — the subscription model
 * lister (`model-list.ts`) and the idle probe's usage-gauge read — and two copies of "spawn the CLI
 * under the sandbox, hold it open, tear it down" would be two places for the sandbox to drift.
 *
 * What is *not* skipped, and never may be: every isolation flag `options.ts` documents
 * (`settingSources: []`, `strictMcpConfig: true`, an empty tool set, deny-all `canUseTool`,
 * `permissionMode: "dontAsk"`) — an idle subprocess is still the CLI running against the operator's
 * own credential directory, CLAUDE.md non-negotiable 2 — and the shared subprocess ceiling
 * (`concurrency.ts`): this is a ~245 MB process like any other, and a bound only some callers honour
 * is not a bound. The slot is taken before the spawn and freed by `close()`.
 *
 * **Never run a real `claude` binary from a test.** `runQuery` is injected for exactly that reason.
 */

/** The slice of the SDK's `Query` an idle reader may touch. Every method is optional so a fake can be small. */
export interface IdleQuery extends AsyncIterable<unknown> {
  supportedModels?(): Promise<unknown>
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: {
    skipBehaviors?: boolean
  }): Promise<unknown>
  /** The handshake itself — `openIdleQuery` resolves once this has. */
  initializationResult?(): Promise<unknown>
  /** The generator's own `return`, which is how the SDK cleans a subprocess up. */
  return?(value?: undefined): Promise<unknown>
}

export type IdleQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}) => IdleQuery

export interface OpenIdleQueryInput {
  /** Whose per-Account subprocess slot this takes. */
  readonly accountId: string
  /** The isolated `CLAUDE_CONFIG_DIR`. Also the subprocess's working directory. */
  readonly configDir: string
  /** Which `claude` binary to spawn — `resolveClaudeCli`'s answer, resolved by the caller first. */
  readonly cliPath: string
  /** The **same instance** the dispatch path holds — one memory budget, one gate. */
  readonly concurrency: SdkConcurrency
  /** Bounds the slot wait and the handshake together. Config, never a constant. */
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  /** Injected in tests, for the reason `SdkInvokerDeps.runQuery` is: no test may spawn a `claude`. */
  readonly runQuery?: IdleQueryFn
  /**
   * The Account's refresh-moment gate (`credential-freshness.ts`). A probe is a subprocess like any
   * other and races the credential file exactly as a turn does — the model catalog refresh was live
   * against one of the three Accounts lost on 2026-09-06.
   */
  readonly freshness?: CredentialFreshness
}

export interface IdleQueryHandle {
  readonly query: IdleQuery
  /**
   * The deadline composed with the caller's signal. Race any further read against it: the
   * handshake had a bound, and what is read after it should have the same one.
   */
  readonly signal: AbortSignal
  /** True once the deadline itself has passed — as opposed to the caller's own abort. */
  timedOut(): boolean
  /** Releases the prompt hold, kills the subprocess, runs the SDK's cleanup, frees the slot. Idempotent. */
  close(): Promise<void>
}

/** Thrown when the deadline passes before the subprocess is ready. Nothing was spawned, or it is dead. */
export class IdleQueryTimeoutError extends Error {
  constructor(readonly phase: "queued" | "handshake") {
    super(
      phase === "queued"
        ? "no claude subprocess slot became free before the deadline (CLAUDE_SDK_MAX_CONCURRENCY)"
        : "the claude subprocess did not complete its handshake before the deadline",
    )
    this.name = "IdleQueryTimeoutError"
  }
}

export async function openIdleQuery(input: OpenIdleQueryInput): Promise<IdleQueryHandle> {
  const runQuery: IdleQueryFn = input.runQuery ?? ((params) => query(params))
  const deadline = AbortSignal.timeout(input.timeoutMs)
  const signal = input.signal === undefined ? deadline : AbortSignal.any([deadline, input.signal])

  // Before the slot, matching `invoker.ts`: one fixed order between the two gates, so they cannot
  // deadlock against each other.
  await (input.freshness ?? ALWAYS_FRESH).ensureFresh(input.accountId, signal)

  let slot: SdkSlot
  try {
    slot = await input.concurrency.acquire(input.accountId, signal)
  } catch (error) {
    // The queue lets go only when the signal does: past the deadline it is the ceiling that was
    // the problem, before it the caller's own abort.
    throw deadline.aborted ? new IdleQueryTimeoutError("queued") : error
  }

  const controller = new AbortController()
  const onAbort = (): void => controller.abort(signal.reason)
  if (signal.aborted) controller.abort(signal.reason)
  else signal.addEventListener("abort", onAbort, { once: true })

  const held = heldOpen()
  let opened: IdleQuery | undefined
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    signal.removeEventListener("abort", onAbort)
    // End the subprocess: close the input it is waiting on, kill it, and let the generator run its
    // own cleanup. Every step is best-effort — a process that is already gone is the goal.
    held.release()
    controller.abort()
    await opened?.return?.()?.catch(() => undefined)
    slot.release()
  }

  try {
    opened = runQuery({ prompt: held.prompt, options: gatedOptions(input, controller) })
    // Ready means the handshake answered, which is what every idle read is answered from. Raced
    // against the signal because the handshake has no deadline of its own.
    await Promise.race([opened.initializationResult?.(), rejectOnAbort(signal)])
  } catch (error) {
    await close()
    throw deadline.aborted ? new IdleQueryTimeoutError("handshake") : error
  }

  return { query: opened, signal, timedOut: () => deadline.aborted, close }
}

/** The same sandbox `options.ts` and `test-probe.ts` build — a third copy that must not drift. */
function gatedOptions(input: OpenIdleQueryInput, controller: AbortController): Options {
  return {
    abortController: controller,
    // Isolation. Each is a distinct path from this host's state into a caller's subprocess; all
    // must be set explicitly, and none may be dropped as cleanup.
    settingSources: [],
    strictMcpConfig: true,
    skills: [],
    tools: [],
    // The one reviewed allowlist (`allowlist.ts`), never a second literal that could drift from it.
    allowedTools: [...PERMITTED_TOOLS],
    permissionMode: "dontAsk",
    canUseTool: denyEveryTool,
    cwd: input.configDir,
    env: { ...subprocessEnv({ configDir: input.configDir }), ...QUERY_ENV_OVERRIDES },
    pathToClaudeCodeExecutable: input.cliPath,
    // Nothing is ever sent, so one is the honest bound: an idle query needs no turn at all.
    maxTurns: 1,
    includePartialMessages: false,
  }
}

/**
 * A prompt that never yields until released. The SDK opens its transport and sends `initialize`
 * before it reads the first message, so holding the stream open is what keeps the subprocess alive
 * exactly as long as the caller needs it, without a turn ever being sent.
 */
function heldOpen(): { readonly prompt: AsyncIterable<SDKUserMessage>; release(): void } {
  let release = (): void => {}
  const closed = new Promise<void>((resolve) => {
    release = resolve
  })
  const done = { done: true, value: undefined } as const
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await closed
        return done
      },
      // The SDK closes the input it was reading when the query ends; nothing is left to wait on.
      return: async () => {
        release()
        return done
      },
    }),
  }
  return { prompt, release }
}

/** Turns a signal into a rejection, so a promise with no deadline of its own can be raced against one. */
export function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

/** No tool an idle query could grant — nothing is ever asked of a model. */
async function denyEveryTool(): Promise<PermissionResult> {
  return { behavior: "deny", message: "an idle query grants no tools" }
}
