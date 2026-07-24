import {
  type Dialect,
  NoHealthyAccountError,
  type RouterError,
  TranslationError,
} from "@multi-ai-router/core"
import type { Logger } from "../../logging/logger"
import type { CredentialCipher } from "../crypto/cipher"
import { type FailoverOptions, type SelectionOptions, selectAccounts } from "../routing"
import { correlationIdFrom, type UsageRecorder } from "../usage"
import type { VerifiedKey } from "./auth/verifier"
import { type BodyReadOptions, readRequestBody } from "./body/read"
import { DEFAULT_SESSION_HEADERS, resolveSessionKey } from "./body/session"
import { runChain } from "./chain"
import { egressRejectionError } from "./egress/mode"
import { buildSnapshot, type HealthStore } from "./health"
import { planCandidates } from "./plan"
import { attemptRecord, errorClassOf, outcomeOf } from "./records"
import { createRuntime } from "./runtime"
import { type DataPlaneClock, type FetchLike, type RoutingCatalog, SYSTEM_CLOCK } from "./types"

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
}

/** Long, because a long completion is a normal response, not a hung one. Configurable. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 600_000

export interface DispatcherDeps {
  readonly catalog: RoutingCatalog
  readonly health: HealthStore
  readonly cipher: Pick<CredentialCipher, "decrypt">
  readonly usage: Pick<UsageRecorder, "record">
  /** Injected so tests need no network and no live provider. Defaults to global `fetch`. */
  readonly fetch?: FetchLike
  readonly clock?: DataPlaneClock
  readonly logger?: Logger
  readonly options?: DispatchOptions
}

export interface DispatchInput {
  readonly ingress: Dialect
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

  return {
    async dispatch(input) {
      const startedAt = clock.now()
      const requestStarted = clock.elapsed()

      const body = await readRequestBody(input.request.body, options.body)
      const model = body.fields.model
      if (model === null) throw new TranslationError(NO_MODEL)

      const session = resolveSessionKey(
        input.request.headers,
        input.key.id,
        body.fields.conversationPrefix,
        options.sessionHeaders ?? DEFAULT_SESSION_HEADERS,
      )

      const runtime = createRuntime({
        health: deps.health,
        cipher: deps.cipher,
        call,
        clock,
        timeoutMs: options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
        record: (record) => deps.usage.record(record),
        correlationId: correlationIdFrom(input.requestId),
        apiKeyId: input.key.id,
        sessionKey: session.key,
        model,
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
        { sessionKey: session.key, model, keyScope: input.key.scope },
        options.selection,
      )
      if (!selection.ok) return fail(selection.error)

      const plan = planCandidates(selection.candidates, deps.catalog, input.ingress)
      if (plan.servable.length === 0) {
        return fail(
          plan.rejection !== null
            ? egressRejectionError(plan.rejection)
            : (plan.endpointError ?? new NoHealthyAccountError(NO_CANDIDATE)),
        )
      }

      return runChain({
        runtime,
        plan: plan.servable,
        request: input.request,
        bodyBytes: body.bytes,
        modelSpan: body.fields.modelSpan,
        failover: options.failover,
        log: deps.logger?.child({ component: "transport", requestId: input.requestId }),
      })
    },
  }
}
