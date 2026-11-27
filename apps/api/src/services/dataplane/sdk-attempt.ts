import type { Logger } from "../../logging/logger"
import type {
  RateLimitSignal,
  SdkFailure,
  SdkInvoker,
  SdkQuotaStore,
  SdkWaitBudget,
  SessionStore,
  SessionTurn,
} from "../../providers"
import {
  UpstreamAdmissionRefused,
  type UpstreamStartGuard,
} from "../../providers/upstream-admission"
import { type AttemptOutcome, attemptDeadline } from "./attempt"
import type { SdkServableCandidate } from "./plan"
import { failure, invocationFailure, NO_TRANSPORT } from "./sdk-attempt-failure"
import {
  errorResponseFailure,
  rateLimitCapture,
  releasingWith,
  truncatedTurnLog,
} from "./sdk-attempt-response"
import { type StreamDeadlines, upstreamDeadline } from "./upstream-deadline"

/**
 * Shared Claude subscription attempt: default SDK or opt-in direct HTTP invoker.
 * Account credentials remain outside the database; the selected config directory is the boundary.
 * Client headers are provided only for the fast transport's explicit protocol allowlist.
 * SDK launch never inherits client authentication or executes host tools.
 * Session lineage brackets SDK calls; fast mode uses complete client histories without that store.
 * Both transports feed the same failover, quota, health and accounting pipeline.
 */

export interface SdkAttemptInput {
  readonly clientHeaders?: Headers
  readonly apiKeyId?: string
  readonly sessionKey?: string
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
  /**
   * Where a `rate_limit_event` folds into Account quota state. Undefined leaves the account's own
   * cooldown reading unwritten — the account still cools down once the next `429` classifies, just
   * a turn later than a stream that reported it early.
   */
  readonly quota?: SdkQuotaStore
  readonly rateLimitObserver?: {
    readonly accepts: () => boolean
    readonly observe: (signal: RateLimitSignal, at: Date) => void
  }
  /** Stamps a `rate_limit_event` reading. Unused when `quota` is undefined. Defaults to the clock. */
  readonly now?: () => Date
  readonly beforeUpstreamStart?: UpstreamStartGuard
  readonly onUpstreamStarted?: () => void
  readonly timeoutMs: number
  /**
   * The request's bounded wait at the shared Claude concurrency gate (`CLAUDE_SDK_QUEUE_WAIT_MS`), shared by every
   * attempt of the request. Absent: the unbounded queue.
   */
  readonly gateWait?: SdkGateWait
  /** First-byte and idle clocks for a streamed turn, from the moment the upstream starts. */
  readonly stream?: StreamDeadlines
  /** The client's own abort signal, so a client that goes away terminates the subprocess. */
  readonly signal?: AbortSignal
  /**
   * The chain's request-scoped logger (component + request id already stamped). Captured by the
   * invocation's callbacks: the render observer fires as the stream drains, after this returned.
   */
  readonly log?: Logger
  /**
   * A previous attempt of this same request learned the SDK no longer knows the resumed session —
   * this attempt is the one in-place replay it earns, and the lineage plan must start fresh
   * rather than resume the disowned id again. Supplied by the chain, which is the only caller
   * that knows what the previous attempt said.
   *
   * The other two lineage inputs (`clientCwd`, `forkOrSubagent` — `session/store.ts`) are
   * deliberately not supplied: no ingress surface carries either fact, so the router has nothing
   * truthful to pass. The seam stays open for a client that one day sends them.
   */
  readonly sessionGone?: boolean
}

export interface SdkGateWait {
  readonly budget: SdkWaitBudget
  /** The `Retry-After` a full gate answers with: the router's wait for a wall naming no instant. */
  readonly retryAfterSeconds: number
}

/** The request's own session identity, plus the store that turns it into a plan. */
export interface SdkSessionContext {
  readonly store: SessionStore
  readonly apiKeyId: string
  /** The router's session key: the client's header verbatim, else the derived fingerprint. */
  readonly sessionKey: string
  readonly keySource: "header" | "fingerprint"
  /** The client named its own agent session; its tool rounds are turns of one conversation. */
  readonly clientToolLoop?: boolean
}

/** No store wired: every turn is a fresh SDK session, which is correct, just cold. */
const NO_SESSION: SessionTurn = {
  plan: { kind: "fresh", reason: "no-session" },
  prepare: () => Promise.resolve(NO_SESSION),
  remember: () => {},
  release: () => {},
}

export async function runSdkAttempt(input: SdkAttemptInput): Promise<AttemptOutcome> {
  const { invoke, plan } = input
  // A router-side configuration fault, not the account's. `server-error` is retryable, so an HTTP
  // account later in the same pool still serves the request instead of the whole chain dying here.
  if (invoke === undefined) return failure("server-error", NO_TRANSPORT)

  // Before the slot and the subprocess: a session bound on another account is carried here first,
  // or the plan turns fresh — the launch must never resume an id this account has never seen.
  const turn = await resolveTurn(input, plan.account.id).prepare()
  // A fresh plan is invisible as an error — it still answers — and visible only as a cold prompt
  // cache and a burnt window. This line is what tells a replay-every-turn loop from a resume.
  input.log?.debug("sdk session plan", {
    accountId: plan.account.id,
    plan: turn.plan.kind,
    ...(turn.plan.kind === "fresh" ? { reason: turn.plan.reason } : {}),
  })
  const rateLimit = rateLimitCapture(input, plan.account.id)
  const total = attemptDeadline(input.timeoutMs, input.signal)
  const clocks =
    input.stream === undefined
      ? undefined
      : upstreamDeadline({ stream: input.stream, client: total, deferred: true })
  const attemptSignal = clocks?.signal ?? total
  let refusal: SdkFailure | undefined

  let response: Response
  try {
    response = await invoke({
      ...(input.clientHeaders === undefined ? {} : { clientHeaders: input.clientHeaders }),
      ...(input.apiKeyId === undefined ? {} : { apiKeyId: input.apiKeyId }),
      ...(input.sessionKey === undefined ? {} : { sessionKey: input.sessionKey }),
      beforeUpstreamStart: input.beforeUpstreamStart,
      onUpstreamStarted: () => {
        clocks?.start()
        input.onUpstreamStarted?.()
      },
      accountId: plan.account.id,
      configDir: plan.configDir,
      model: plan.upstreamModel,
      body: input.body,
      signal: attemptSignal,
      ...(input.gateWait === undefined ? {} : { queueWait: input.gateWait.budget }),
      session: turn.plan,
      onSession: (report) => turn.remember(report.sdkSessionId, report.assistantUuid),
      onRateLimit: rateLimit.capture,
      onRefusal: (failure) => {
        refusal = failure
      },
      onTruncatedTurn: truncatedTurnLog(input.log, plan.account.id),
    })
    clocks?.headersArrived()
  } catch (error) {
    clocks?.release()
    // Released here as well as from `onTurnEnd`, and idempotently: a throw before the launch ever
    // existed reaches no `onEnd`, and the *next* attempt of this same request must be able to claim
    // the conversation immediately rather than fail over onto a detached, session-less turn.
    turn.release("failed")
    rateLimit.close()
    if (error instanceof UpstreamAdmissionRefused) return { kind: "admission-refused" }
    return invocationFailure(error, input, turn, rateLimit.signal(), attemptSignal)
  }

  // The renderer answers a non-streaming turn that ended in an upstream `error` event with the
  // error's own body under a real status (`render/stream.ts`). No byte of it has reached the
  // client — the whole object was built before this returned — so it is a *failed attempt*, free
  // to fail over, not a success to relay: wrapping it as one recorded a success on the account,
  // reset its failure streak, and handed the client a 502 while healthy candidates sat unasked.
  // The streaming path is the opposite case by construction: its Response is always 200, and a
  // mid-stream failure is spelled as a terminal SSE frame after bytes are out — never retried.
  // The same reason as the catch above: this attempt is over and the chain may try another
  // account, which resolves its own turn against this conversation.
  if (response.status >= 400) {
    clocks?.release()
    turn.release("failed")
    try {
      return await errorResponseFailure(response, rateLimit.signal(), refusal)
    } finally {
      rateLimit.close()
    }
  }

  // Rate-limit and quota state does not ride the HTTP response here: it arrives as
  // `rate_limit_event` messages inside the query stream, which `rateLimitCapture` folds into
  // Account state exactly as `applyRateLimit` folds in an HTTP driver's parsed headers
  // (docs/idea/11-anthropic-agent-sdk.md §5).
  // The conversation stays this turn's until the answer has finished being produced — which, on a
  // streaming turn, is long after this function returned. Releasing any earlier lets a client's
  // hidden one-shot resume a session still in use, which is the collision the claim exists to
  // prevent (`claude-sdk/session/inflight.ts`).
  return {
    kind: "success",
    response: releasingWith(clocks?.watch(response) ?? response, () => {
      rateLimit.close()
      turn.release()
    }),
    rateLimit: rateLimit.signal(),
    ...(turn.plan.kind !== "fresh" && turn.plan.carryFrom !== undefined
      ? { sessionCarried: true }
      : {}),
  }
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
    ...(session.clientToolLoop === true ? { clientToolLoop: true } : {}),
    accountId,
    body: input.body,
    ...(input.sessionGone === undefined ? {} : { sessionGone: input.sessionGone }),
  })
}
