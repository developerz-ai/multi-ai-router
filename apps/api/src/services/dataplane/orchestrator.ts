import { type RouterError, TranslationError } from "@multi-ai-router/core"
import { type FailoverOptions, selectAccounts } from "../routing"
import { clientRequestIdFrom, correlationIdFrom } from "../usage"
import { readRequestBody } from "./body/read"
import { MODEL_NAME_MAX_BYTES } from "./body/scanner"
import { DEFAULT_SESSION_HEADERS, resolveSessionKey } from "./body/session"
import { runChain } from "./chain"
import type { Dispatcher, DispatcherDeps, DispatchInput } from "./dispatcher-config"
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "./dispatcher-config"
import { resolveEgress } from "./egress/mode"
import { keyRateLimitedError } from "./limits"
import { outcomeForResponse, type RequestProgress, sampleOf, streamed } from "./observe"
import { planCandidates } from "./plan"
import { attemptRecord, errorClassOf, outcomeOf } from "./records"
import { createRuntime } from "./runtime"
import { sessionBindings } from "./session-binding"
import { withSessionRestart } from "./session-restart"
import { buildSnapshot } from "./snapshot"
import { createTranslatedRequestBody } from "./translate-body"
import { SYSTEM_CLOCK } from "./types"
import { unservableError } from "./unservable"

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
 * A failure in preflight still writes a `UsageRecord` **once the body has named a model** — an
 * attempt that failed before selection has no account, and the spec wants that row anyway, because
 * "nothing in this key's scope" is exactly the kind of failure an operator needs to see counted.
 * The refusals *before* a model exists write none, deliberately: `UsageRecord.model` is
 * non-nullable by design, so a row for a key over its ceiling, an unreadable body, or a body that
 * names no model (or one too long to be one) would have to claim a model nobody named. Those
 * refusals are counted on `router_requests_total` by the request observer below instead.
 */

/**
 * How many dropped fields one log line spells out. Not an operator knob: it bounds one rendered
 * field the way the redactor bounds an `Error`; the count beside it is always complete.
 */
const MAX_REPORTED_DROPS = 20

const NO_MODEL = "The request body must name a model"
const MODEL_TOO_LONG = `The request body's model name is longer than ${MODEL_NAME_MAX_BYTES} bytes`

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

    const body = await readRequestBody(input.request, options.body)
    const model = body.fields.model
    // Before the "name a model" refusal, because the body *did* name one and saying otherwise
    // sends a caller looking for a missing field. Refused rather than truncated: a shortened
    // model name is a substituted model (non-negotiable 4).
    if (body.fields.modelTooLong) throw new TranslationError(MODEL_TOO_LONG)
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
    // A `blocked` binding is deliberately kept: the account is coming back on a clock and the
    // conversation stays resumable, so the request fails honestly instead. An `invalidated` one
    // is *not* dropped here — see below: the store mutation waits for a replacement to exist,
    // because dropping it and then failing anyway loses the conversation for nothing.
    if (!selection.ok) return fail(selection.error)

    const plan = planCandidates(selection.candidates, deps.catalog, input.ingress, operation)
    if (plan.servable.length === 0) {
      // Off the served path entirely, so the second catalog read this costs is free: it only
      // happens once the chain is already known to be empty.
      const accounts = new Map(deps.catalog.accounts().map((one) => [one.id, one]))
      return fail(
        unservableError({
          plan,
          decision: selection.decision,
          capable: (accountId) => {
            const account = accounts.get(accountId)
            if (account === undefined) return false
            return resolveEgress(input.ingress, account, operation).mode !== "rejected"
          },
          now: clock.now(),
        }),
      )
    }

    // Dropped, never moved — and only now, with a servable replacement in hand. Selection said
    // the binding cannot be honored (`rebind` on a cooling account, out of scope, exhausted, the
    // account gone); acting on that verdict *before* knowing whether anything else could serve
    // was the bug that turned a pool-wide cooldown under `rebind` into a lost conversation: the
    // binding went, selection failed anyway, and the client's post-429 retry found a healthy
    // account holding a cold session. A chain that fails from here still loses the binding — a
    // narrow window, accepted — while an SDK success re-points it through its own `remember`.
    const decidedBinding = selection.decision.binding
    if (decidedBinding.state === "invalidated") {
      bindings.invalidate(input.key.id, session.key)
      deps.logger?.info("session binding invalidated", {
        component: "dataplane",
        requestId: input.requestId,
        accountId: decidedBinding.accountId,
        reason: decidedBinding.reason,
      })
    }

    // Injected, never read off a clock inside a translator: the same recorded body must convert to
    // the same bytes in a test as it does on the wire.
    const translation = {
      created: Math.floor(startedAt.getTime() / 1000),
      model,
      fallbackId: input.requestId,
      defaultMaxTokens: options.translation?.defaultMaxTokens,
    }

    // The bound account travels into the chain so a mid-chain hop off it is *known* to be one —
    // without it, `leavingBound` could never be true and a restarted session went unsurfaced.
    const failover: FailoverOptions = {
      ...options.failover,
      ...(decidedBinding.state === "honored" ? { boundAccountId: decidedBinding.accountId } : {}),
    }

    const log = deps.logger?.child({ component: "transport", requestId: input.requestId })

    const response = await runChain({
      runtime,
      plan: plan.servable,
      request: input.request,
      bodyBytes: body.bytes,
      modelSpan: body.fields.modelSpan,
      translation,
      translated: createTranslatedRequestBody(body.bytes, translation, (pair, drops) =>
        // One line per conversion, naming every field the target could not carry. `warn`, because
        // the caller was answered without something it sent — the surfacing rule in
        // `06-protocol-translation.md#known-lossy-edges`.
        log?.warn("translation dropped fields", {
          component: "translate",
          ingress: pair.ingress,
          egress: pair.egress,
          dropped: drops.length,
          fields: drops.slice(0, MAX_REPORTED_DROPS).map((drop) => `${drop.field} ${drop.reason}`),
        }),
      ),
      failover,
      log,
      ...(options.log?.reasonMaxChars === undefined
        ? {}
        : { reasonMaxChars: options.log.reasonMaxChars }),
    })

    // The other half of "surfaced, never silently truncated": this turn started a fresh upstream
    // session where a bound one used to be, and the client is told so (`session-restart.ts`).
    return decidedBinding.state === "invalidated"
      ? withSessionRestart(response, decidedBinding.reason)
      : response
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
