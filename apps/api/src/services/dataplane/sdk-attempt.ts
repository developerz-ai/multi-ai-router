import { UpstreamTimeoutError } from "@multi-ai-router/core"
import {
  classifySdkFailure,
  type SdkInvoker,
  type SessionStore,
  type SessionTurn,
} from "../../providers"
import { type AttemptOutcome, attemptDeadline, failoverKind } from "./attempt"
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
 *
 * **A failure arrives as prose, not as a status** (§9). `providers/claude-sdk/errors.ts` reads the
 * class out of it and this module applies the one consequence that belongs to the attempt itself:
 * a stale session drops the binding that named it, so the replay the failover planner schedules
 * opens a fresh session instead of resuming one the CLI has already forgotten.
 *
 * **Session lineage brackets the call** (§4). Before it, a resume/fork/fresh plan is resolved from
 * what this Account's SDK sessions already hold; after it, whatever session the SDK named is
 * recorded against this Account. Both sides are keyed by Account because an SDK session id resumes
 * nowhere else — which is also why the record is written only once a session id exists, and why a
 * failed attempt records nothing: a binding to an Account that produced no session would pin the
 * conversation there for no gain and cost the next turn a failover it could have had.
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
  /** Session lineage for this request. Undefined leaves every turn a fresh SDK session. */
  readonly session: SdkSessionContext | undefined
  readonly timeoutMs: number
  /** The client's own abort signal, so a client that goes away terminates the subprocess. */
  readonly signal?: AbortSignal
}

/** The request's own session identity, plus the store that turns it into a plan. */
export interface SdkSessionContext {
  readonly store: SessionStore
  readonly apiKeyId: string
  /** The router's session key: the client's header verbatim, else the derived fingerprint. */
  readonly sessionKey: string
  readonly keySource: "header" | "fingerprint"
}

/** No store wired: every turn is a fresh SDK session, which is correct, just cold. */
const NO_SESSION: SessionTurn = {
  plan: { kind: "fresh", reason: "no-session" },
  remember: () => {},
}

const NO_TRANSPORT =
  "no Claude Agent SDK transport is configured on this router: a subscription account cannot be dispatched to"

const DEADLINE = "the Agent SDK did not answer within its deadline"

export async function runSdkAttempt(input: SdkAttemptInput): Promise<AttemptOutcome> {
  const { invoke, plan } = input
  // A router-side configuration fault, not the account's. `server-error` is retryable, so an HTTP
  // account later in the same pool still serves the request instead of the whole chain dying here.
  if (invoke === undefined) return failure("server-error", NO_TRANSPORT)

  const turn = resolveTurn(input, plan.account.id)

  let response: Response
  try {
    response = await invoke({
      accountId: plan.account.id,
      configDir: plan.configDir,
      model: plan.upstreamModel,
      body: input.body,
      signal: attemptDeadline(input.timeoutMs, input.signal),
      session: turn.plan,
      onSession: (report) => turn.remember(report.sdkSessionId, report.assistantUuid),
    })
  } catch (error) {
    return invocationFailure(error, input, turn)
  }

  // Rate-limit and quota state does not ride the HTTP response here: it arrives as
  // `rate_limit_event` messages inside the query stream, which the renderer feeds to Account state
  // and never forwards to the client (docs/idea/11-anthropic-agent-sdk.md §5).
  return { kind: "success", response, rateLimit: null }
}

/**
 * The lineage plan for this attempt, against *this* account.
 *
 * Resolved per attempt rather than per request on purpose: a failover to a second subscription
 * account is a different set of SDK sessions, so the first account's plan would resume a session
 * the second one has never heard of.
 */
function resolveTurn(input: SdkAttemptInput, accountId: string): SessionTurn {
  const session = input.session
  if (session === undefined) return NO_SESSION

  return session.store.resolve({
    apiKeyId: session.apiKeyId,
    sessionKey: session.sessionKey,
    keySource: session.keySource,
    accountId,
    body: input.body,
  })
}

/**
 * What an invoker throwing means.
 *
 * A deadline is the one class read off the error *object* — a composed signal fires with a name,
 * and the idle guard raises its own `504` — because a subprocess that said nothing said nothing in
 * every language. Everything the SDK itself reports is prose and goes to `classifySdkFailure`.
 */
function invocationFailure(
  error: unknown,
  input: SdkAttemptInput,
  turn: SessionTurn,
): AttemptOutcome {
  if (isDeadline(error)) return failure("timeout", DEADLINE)

  const { classification, clientMessage } = classifySdkFailure(error)
  if (classification.kind === "stale-session") evictBinding(input, turn)

  return {
    kind: "failure",
    failure: {
      kind: failoverKind(classification.kind, classification.status),
      status: classification.status,
      // Router-authored: this is the sentence a client reads when no account could serve, and the
      // SDK's own wording never becomes one (docs/idea/07-security.md).
      message: clientMessage,
    },
    classification,
    // The account's quota state rides `rate_limit_event`, never the throw (§5).
    rateLimit: null,
    upstream: null,
  }
}

function isDeadline(error: unknown): boolean {
  if (error instanceof UpstreamTimeoutError) return true
  const name = error instanceof Error ? error.name : ""
  return name === "TimeoutError" || name === "AbortError"
}

/**
 * The SDK says it has never heard of the session we resumed, so the binding that named it is wrong
 * and stays wrong. Dropped rather than moved: an SDK session id resumes nowhere but the Account that
 * minted it, and this one resumes nowhere at all.
 */
function evictBinding(input: SdkAttemptInput, turn: SessionTurn): void {
  const session = input.session
  // A fresh turn resumed nothing, so there is no binding this failure discredits.
  if (session === undefined || turn.plan.kind === "fresh") return
  session.store.invalidate(session.apiKeyId, session.sessionKey)
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
