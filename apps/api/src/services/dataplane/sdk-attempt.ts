import type { SdkInvoker } from "../../providers"
import { type AttemptOutcome, attemptDeadline } from "./attempt"
import type { SdkServableCandidate } from "./plan"

/**
 * One Claude subscription attempt, in the same shape an HTTP one answers in.
 *
 * That symmetry is the whole design. `runAttempt` addresses a URL and relays what comes back;
 * this addresses a `CLAUDE_CONFIG_DIR` and hands back what the SDK produced. Both answer with an
 * `AttemptOutcome`, so the failover loop, the health store, the token observer, the relay, and the
 * `UsageRecord` are each written once — the transport difference stops at this module's edge.
 *
 * Two things are absent by construction rather than by discipline:
 *
 * - **No credential is decrypted.** `egress/credential.ts` is never reached from here. A
 *   subscription Account holds `authMaterial === null`; its credentials live inside the config
 *   directory and only the `claude` CLI reads them (docs/idea/11-anthropic-agent-sdk.md §3).
 * - **No client header is forwarded.** There is no request to attach them to. The client's own
 *   `anthropic-beta` opt-ins, `x-api-key`, and everything else stop at the router, which is also
 *   the per-Account billing-safety property the spec asks for (§7).
 *
 * The invoker is injected because spawning a subprocess is I/O: the data plane must be dispatchable
 * without one, and no test may spawn a real `claude` CLI.
 */

export interface SdkAttemptInput {
  readonly plan: SdkServableCandidate
  /** Anthropic Messages request bytes, already converted from the client's dialect if it differed. */
  readonly body: Uint8Array | null
  /**
   * The transport. Undefined in a build or deployment where no Agent SDK is wired, which fails this
   * attempt honestly rather than silently degrading a subscription request onto some other path.
   */
  readonly invoke: SdkInvoker | undefined
  readonly timeoutMs: number
  /** The client's own abort signal, so a client that goes away terminates the subprocess. */
  readonly signal?: AbortSignal
}

const NO_TRANSPORT =
  "no Claude Agent SDK transport is configured on this router: a subscription account cannot be dispatched to"

export async function runSdkAttempt(input: SdkAttemptInput): Promise<AttemptOutcome> {
  const { invoke, plan } = input
  // A router-side configuration fault, not the account's. `server-error` is retryable, so an HTTP
  // account later in the same pool still serves the request instead of the whole chain dying here.
  if (invoke === undefined) return failure("server-error", NO_TRANSPORT)

  let response: Response
  try {
    response = await invoke({
      accountId: plan.account.id,
      configDir: plan.configDir,
      model: plan.upstreamModel,
      body: input.body,
      signal: attemptDeadline(input.timeoutMs, input.signal),
    })
  } catch (error) {
    return invocationFailure(error)
  }

  // Rate-limit and quota state does not ride the HTTP response here: it arrives as
  // `rate_limit_event` messages inside the query stream, which the renderer feeds to Account state
  // and never forwards to the client (docs/idea/11-anthropic-agent-sdk.md §5).
  return { kind: "success", response, rateLimit: null }
}

/**
 * What an invoker throwing means.
 *
 * Only the two classes this seam can know are named. Everything the SDK itself reports — an expired
 * credential, a spent window, a session the CLI no longer has — arrives as a **string** in the query
 * stream, so classifying it belongs to the module that reads that stream, not here.
 */
function invocationFailure(error: unknown): AttemptOutcome {
  const name = error instanceof Error ? error.name : ""
  return name === "TimeoutError" || name === "AbortError"
    ? failure("timeout", "the Agent SDK did not answer within its deadline")
    : failure("server-error", "the Agent SDK could not be invoked for this account")
}

function failure(kind: "timeout" | "server-error", message: string): AttemptOutcome {
  return {
    kind: "failure",
    failure: { kind, message },
    classification: null,
    rateLimit: null,
    // Nothing answered, so there is no upstream body to relay. The chain surfaces a router-shaped
    // error instead of inventing a provider-shaped one.
    upstream: null,
  }
}
