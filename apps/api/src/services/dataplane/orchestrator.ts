import {
  type Dialect,
  NoHealthyAccountError,
  type RouterError,
  TranslationError,
} from "@multi-ai-router/core"
import type { Logger } from "../../logging/logger"
import type { SdkInvoker, SdkQuotaStore, SessionStore } from "../../providers"
import type { RateLookup } from "../cost"
import type { CredentialCipher } from "../crypto/cipher"
import { type FailoverOptions, type SelectionOptions, selectAccounts } from "../routing"
import { clientRequestIdFrom, correlationIdFrom, type UsageRecorder } from "../usage"
import type { VerifiedKey } from "./auth/verifier"
import { type BodyReadOptions, readRequestBody } from "./body/read"
import { DEFAULT_SESSION_HEADERS, resolveSessionKey } from "./body/session"
import { runChain } from "./chain"
import { egressRejectionError } from "./egress/mode"
import { buildSnapshot, type HealthStore } from "./health"
import { keyRateLimitedError, type RateLimiter } from "./limits"
import { outcomeForResponse, type RequestProgress, sampleOf, streamed } from "./observe"
import { planCandidates } from "./plan"
import { attemptRecord, errorClassOf, outcomeOf } from "./records"
import { createRuntime } from "./runtime"
import { sessionBindings } from "./session-binding"
import { createTranslatedRequestBody } from "./translate-body"
import {
  type DataPlaneClock,
  type FetchLike,
  type RequestObserver,
  type RoutingCatalog,
  SYSTEM_CLOCK,
  type UpstreamOperation,
} from "./types"

/**
 * The request lifecycle, steps 3-12 of `docs/idea/01-architecture.md`:
 *
 *     read routing fields -> resolve session -> health snapshot -> select -> plan egress
 *                         -> attempt chain -> relay
 *
 * Everything before the chain is preflight and is deliberately cheap: the body is read once and
 * scanned incrementally for two fields, the snapshot is assembled from warm memory, and selection
 * is a pure function. Nothing here opens a socket or touches Postgres.
 *
 * A failure in preflight still writes a `UsageRecord` — an attempt that failed before selection
 * has no account, and the spec wants that row anyway, because "nothing in this key's scope" is
 * exactly the kind of failure an operator needs to see counted.
 */

export interface DispatchOptions {
  readonly selection?: SelectionOptions
  readonly failover?: FailoverOptions
  readonly body?: BodyReadOptions
  /** Headers a client may name its conversation with. See `body/session.ts`. */
  readonly sessionHeaders?: readonly string[]
  readonly upstreamTimeoutMs?: number
  readonly translation?: TranslationOptions
}

export interface TranslationOptions {
  /**
   * The `max_tokens` an Anthropic egress is given when the client's dialect made it optional and
   * the client omitted it. Operator-configured, deliberately generous: a low ceiling would truncate
   * an answer the caller never asked to truncate (`06-protocol-translation.md#known-lossy-edges`).
   */
  readonly defaultMaxTokens?: number
}

/** Long, because a long completion is a normal response, not a hung one. Configurable. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 600_000

export interface DispatcherDeps {
  readonly catalog: RoutingCatalog
  readonly health: HealthStore
  readonly cipher: Pick<CredentialCipher, "decrypt">
  readonly usage: Pick<UsageRecorder, "record">
  /**
   * Enforces the ceiling stored on the key. Omitted means unlimited — a dispatcher built without
   * one behaves exactly as this router did before limits were enforced.
   */
  readonly limiter?: Pick<RateLimiter, "check">
  /** Injected so tests need no network and no live provider. Defaults to global `fetch`. */
  readonly fetch?: FetchLike
  /**
   * The Claude subscription transport. Injected for the same reason `fetch` is — no test may spawn
   * a real `claude` CLI. Omitted means this router serves no subscription account, and one selected
   * fails its attempt by name rather than being routed onto some other path.
   */
  readonly invokeSdk?: SdkInvoker
  /**
   * Session -> Account bindings. Omitted, every subscription turn starts a fresh SDK session and
   * routing places it freely — correct, and cold. Present, a bound session is where selection
   * starts and where an SDK resume becomes possible at all (`session-binding.ts`).
   */
  readonly sessions?: SessionStore
  /**
   * Where a `rate_limit_event` folds into Account quota state. Omitted, a subscription attempt
   * still classifies a spent window from a later `429` — it just cannot cool the account down a
   * turn early, the way an HTTP driver's parsed headers do.
   */
  readonly quota?: SdkQuotaStore
  /** The operator's warm price overrides. Omitted, attempts price off the shipped table. */
  readonly prices?: RateLookup
  readonly clock?: DataPlaneClock
  readonly logger?: Logger
  /** Notified once per client request, after it ended. Feeds `router_requests_total`. */
  readonly onRequest?: RequestObserver
  readonly options?: DispatchOptions
}

export interface DispatchInput {
  readonly ingress: Dialect
  /**
   * What the called route asks of an Account. Omitted is `messages` — inference, which is what
   * every ingress path but `POST /v1/messages/count_tokens` and `POST /v1/embeddings` performs. It
   * travels with the request rather than being derived from the URL because the URL is the *route's*
   * to know: everything below this line addresses an upstream, and an upstream's path is not the
   * client's.
   */
  readonly operation?: UpstreamOperation
  readonly request: Request
  readonly key: VerifiedKey
  /** The correlation id assigned at ingress and propagated end to end. */
  readonly requestId: string
}

export interface Dispatcher {
  dispatch(input: DispatchInput): Promise<Response>
}

const NO_MODEL = "The request body must name a model"
const NO_CANDIDATE = "No candidate account can serve this request"

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const clock = deps.clock ?? SYSTEM_CLOCK
  const call = deps.fetch ?? ((request: Request) => fetch(request))
  const options = deps.options ?? {}
  const bindings = sessionBindings(deps.catalog, deps.sessions)

  /**
   * The request itself. `progress` carries the two readings the observer needs but only this
   * function learns: when the request started, and what model its body named.
   */
  const serve = async (input: DispatchInput, progress: RequestProgress): Promise<Response> => {
    const { startedAt, requestStarted } = progress
    const operation = input.operation ?? "messages"

    // Before the body: refusing a key over its ceiling must cost less than serving it, and no
    // usage row is written because nothing was attempted — the refusal is counted on
    // `router_requests_total{outcome="key_rate_limited"}` by the observer below.
    const limit = deps.limiter?.check(input.key, startedAt.getTime())
    if (limit !== undefined && !limit.allowed) throw keyRateLimitedError(input.key, limit)

    const body = await readRequestBody(input.request.body, options.body)
    const model = body.fields.model
    if (model === null) throw new TranslationError(NO_MODEL)
    progress.model = model

    const session = resolveSessionKey(
      input.request.headers,
      input.key.id,
      body.fields.conversationPrefix,
      options.sessionHeaders ?? DEFAULT_SESSION_HEADERS,
    )

    // Read before selection because selection may not overrule it: an SDK session id resumes only
    // on the account that minted it, so this is persisted truth, not a routing preference.
    const binding = await bindings.read(input.key.id, session.key)

    const runtime = createRuntime({
      health: deps.health,
      cipher: deps.cipher,
      call,
      ...(deps.invokeSdk === undefined ? {} : { invokeSdk: deps.invokeSdk }),
      ...(deps.sessions === undefined ? {} : { sessions: deps.sessions }),
      ...(deps.quota === undefined ? {} : { quota: deps.quota }),
      ...(deps.prices === undefined ? {} : { prices: deps.prices }),
      sessionKeySource: session.source,
      clock,
      timeoutMs: options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
      record: (record) => deps.usage.record(record),
      // Two different ids on purpose: the correlation id is router-owned and joins this
      // request's attempts, while the client's own id is a trace label a caller may repeat or
      // forge. Using the latter as the join key would merge two clients' chains.
      correlationId: correlationIdFrom(input.requestId),
      clientRequestId: clientRequestIdFrom(input.requestId),
      apiKeyId: input.key.id,
      sessionKey: session.key,
      model,
      ingressDialect: input.ingress,
      operation,
      requestStarted,
    })

    const fail = (error: RouterError): never => {
      runtime.record(
        attemptRecord({
          ...runtime.preflightAttribution(),
          timing: runtime.timing(startedAt, requestStarted, 0),
          outcome: outcomeOf(error),
          streamed: false,
          httpStatus: null,
          errorClass: errorClassOf(error),
        }),
      )
      throw error
    }

    // Scope intersection, filtering, and policy — one pure call over an injected snapshot.
    const selection = selectAccounts(
      buildSnapshot(deps.catalog, deps.health, clock.now()),
      { sessionKey: session.key, model, keyScope: input.key.scope, binding },
      options.selection,
    )
    // Dropped, never moved. A `blocked` binding is deliberately kept: the account is coming back
    // on a clock and the conversation stays resumable, so the request fails honestly instead.
    if (selection.decision.binding.state === "invalidated") {
      bindings.invalidate(input.key.id, session.key)
    }
    if (!selection.ok) return fail(selection.error)

    const plan = planCandidates(selection.candidates, deps.catalog, input.ingress, operation)
    if (plan.servable.length === 0) {
      return fail(
        plan.rejection !== null
          ? egressRejectionError(plan.rejection)
          : (plan.endpointError ?? new NoHealthyAccountError(NO_CANDIDATE)),
      )
    }

    // Injected, never read off a clock inside a translator: the same recorded body must convert to
    // the same bytes in a test as it does on the wire.
    const translation = {
      created: Math.floor(startedAt.getTime() / 1000),
      model,
      fallbackId: input.requestId,
      defaultMaxTokens: options.translation?.defaultMaxTokens,
    }

    return runChain({
      runtime,
      plan: plan.servable,
      request: input.request,
      bodyBytes: body.bytes,
      modelSpan: body.fields.modelSpan,
      translation,
      translated: createTranslatedRequestBody(body.bytes, translation),
      failover: options.failover,
      log: deps.logger?.child({ component: "transport", requestId: input.requestId }),
    })
  }

  const observe = deps.onRequest

  return {
    async dispatch(input) {
      const progress: RequestProgress = {
        startedAt: clock.now(),
        requestStarted: clock.elapsed(),
        model: null,
      }
      if (observe === undefined) return serve(input, progress)

      const identity = { ingressDialect: input.ingress, keyId: input.key.id }
      try {
        const response = await serve(input, progress)
        observe(
          sampleOf(identity, progress, outcomeForResponse(response), clock, streamed(response)),
        )
        return response
      } catch (error) {
        observe(sampleOf(identity, progress, outcomeOf(error), clock, false))
        throw error
      }
    },
  }
}
