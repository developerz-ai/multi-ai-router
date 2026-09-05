import type { Dialect } from "@multi-ai-router/core"
import type { Logger } from "../../logging/logger"
import type { SdkInvoker, SdkQuotaStore, SessionStore } from "../../providers"
import type { RateLookup } from "../cost"
import type { CredentialCipher } from "../crypto/cipher"
import type { FailoverOptions, SelectionOptions } from "../routing"
import type { UsageRecorder } from "../usage"
import type { VerifiedKey } from "./auth/verifier"
import type { BodyReadOptions } from "./body/read"
import type { HealthStore } from "./health"
import type { RateLimiter } from "./limits"
import type {
  DataPlaneClock,
  FetchLike,
  RequestObserver,
  RoutingCatalog,
  UpstreamOperation,
} from "./types"

/**
 * The dispatcher's configuration surface — everything `createDispatcher` is built *with*, split
 * from `orchestrator.ts`, which owns what a request *does*. The two change for different reasons:
 * this file grows a field when the operator gets a knob, that one changes when the lifecycle does.
 */

export interface DispatchOptions {
  readonly selection?: SelectionOptions
  readonly failover?: FailoverOptions
  readonly body?: BodyReadOptions
  /** Headers a client may name its conversation with. See `body/session.ts`. */
  readonly sessionHeaders?: readonly string[]
  readonly upstreamTimeoutMs?: number
  readonly translation?: TranslationOptions
  readonly log?: LogOptions
}

export interface LogOptions {
  /**
   * How much of an upstream's own error text a failed-attempt log line quotes —
   * `LOG_REASON_MAX_CHARS`, the same knob every other quoted reason in the process obeys. The
   * composition root passes the parsed value; absent means {@link DEFAULT_LOG_REASON_MAX_CHARS}.
   */
  readonly reasonMaxChars?: number
}

/**
 * Mirrors the env schema's default for `LOG_REASON_MAX_CHARS`, so a dispatcher built without the
 * option (a test, an older composition root) bounds the same way the configured one does.
 */
export const DEFAULT_LOG_REASON_MAX_CHARS = 200

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
