import type { RouterError } from "@multi-ai-router/core"
import { type FailoverOptions, selectAccounts } from "../routing"
import { createRequestIdentity, type UsageRequestIdentity } from "../usage/request-identity"
import { admitRoutingModel, refuseEncodedBody } from "./body/preflight"
import { DEFAULT_SESSION_HEADERS, resolveSessionKey } from "./body/session"
import { readTrackedRequestBody } from "./body-progress"
import { runChain } from "./chain"
import type { Dispatcher, DispatcherDeps, DispatchInput } from "./dispatcher-config"
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "./dispatcher-config"
import { resolveEgress } from "./egress/mode"
import { keyRateLimitedError } from "./limits"
import type { RequestProgress } from "./observe"
import { planCandidates } from "./plan"
import { attemptRecord, errorClassOf, outcomeOf } from "./records"
import { hintRecoveryRejections } from "./recovery-hints"
import { createRequestAccounting, type RequestAccounting } from "./request-accounting"
import { requestLifetime } from "./request-lifetime"
import { requestTerminalObserver } from "./request-terminal"
import { createRotationCounters } from "./rotation"
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
 * Every authenticated refusal is accounted for, including those before a model is known.
 * Missing model/account/upstream facts stay null; no selected account is charged for preparation.
 */

/**
 * How many dropped fields one log line spells out. Not an operator knob: it bounds one rendered
 * field the way the redactor bounds an `Error`; the count beside it is always complete.
 */
const MAX_REPORTED_DROPS = 20

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const clock = deps.clock ?? SYSTEM_CLOCK
  const call = deps.fetch ?? ((request: Request) => fetch(request))
  const options = deps.options ?? {}
  const bindings = sessionBindings(
    deps.catalog,
    deps.sessions,
    deps.onBindingWait === undefined
      ? undefined
      : { elapsed: clock.elapsed, onWait: deps.onBindingWait },
  )
  // Per pool, per replica, in memory — the caller-owned half of `round-robin` (`rotation.ts`).
  const rotation = createRotationCounters()

  /** Progress shares the request start and discovered model with accounting. */
  const serve = async (
    input: DispatchInput & { readonly identity: UsageRequestIdentity },
    progress: RequestProgress,
    accounting: Pick<RequestAccounting, "record" | "recordTerminal" | "selectTerminal">,
  ): Promise<Response> => {
    const { startedAt, requestStarted } = progress
    const operation = input.operation ?? "messages"

    const limit = deps.limiter?.check(input.key, startedAt.getTime())
    if (limit !== undefined && !limit.allowed) throw keyRateLimitedError(input.key, limit)

    refuseEncodedBody(input.request.headers)

    const body = await readTrackedRequestBody(input.request, options.body, progress, clock)
    input.request.signal.throwIfAborted()
    const model = admitRoutingModel(body.fields, body.bytes.length)
    progress.model = model

    const session = resolveSessionKey(
      input.request.headers,
      input.key.id,
      body.fields.conversationPrefix,
      options.sessionHeaders ?? DEFAULT_SESSION_HEADERS,
    )

    // A bound SDK session belongs to its original account before routing selection.
    const binding =
      deps.sessions && session.source !== "unbound"
        ? await bindings.read(input.key.id, session.key)
        : undefined
    input.request.signal.throwIfAborted()

    const runtime = createRuntime({
      ...(input.activeRequest === undefined ? {} : { activeRequest: input.activeRequest }),
      health: deps.health,
      ...(options.selection?.unknownResetRetryAfterSeconds === undefined
        ? {}
        : { unknownResetRetryAfterSeconds: options.selection.unknownResetRetryAfterSeconds }),
      ...(options.selection?.quotaSpentThreshold === undefined
        ? {}
        : { quotaSpentThreshold: options.selection.quotaSpentThreshold }),
      ...(deps.recovery === undefined ? {} : { recovery: deps.recovery }),
      cipher: deps.cipher,
      call,
      ...(deps.invokeSdk === undefined ? {} : { invokeSdk: deps.invokeSdk }),
      ...(deps.sessions === undefined || session.source === "unbound"
        ? {}
        : { sessions: deps.sessions }),
      ...(deps.quota === undefined ? {} : { quota: deps.quota }),
      ...(deps.prices === undefined ? {} : { prices: deps.prices }),
      sessionKeySource: session.source,
      clock,
      timeoutMs: options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
      ...(options.upstreamErrorMaxBytes === undefined
        ? {}
        : { errorMaxBytes: options.upstreamErrorMaxBytes }),
      bodyReadMs: progress.bodyReadMs,
      responseObservationMaxBytes: options.responseObservationMaxBytes ?? 65_536,
      record: accounting.record,
      recordTerminal: accounting.recordTerminal,
      selectTerminal: accounting.selectTerminal,
      // Two different ids on purpose: the correlation id is router-owned and joins this
      // request's attempts, while the client's own id is a trace label a caller may repeat or
      // forge. Using the latter as the join key would merge two clients' chains.
      correlationId: input.identity.correlationId,
      clientRequestId: input.identity.clientRequestId,
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
      buildSnapshot(deps.recovery?.catalog ?? deps.catalog, deps.health, clock.now(), rotation),
      {
        sessionKey: session.key,
        model,
        keyScope: input.key.scope,
        binding,
        rotationCounter: rotation.current(null),
      },
      options.selection,
    )
    // The rotation moved only if the policy placed this session. A honored binding chose nothing —
    // the bound account is the head whatever the counter says — and counting it would leave new
    // sessions landing at whatever offset the bound traffic stopped on (`rotation.ts`).
    if (selection.decision.binding.state !== "honored") {
      for (const group of selection.decision.groups) rotation.advance(group.poolId)
    }
    // A `blocked` binding is deliberately kept: the account is coming back on a clock and the
    // conversation stays resumable, so the request fails honestly instead. An `invalidated` one
    // is *not* dropped here — see below: the store mutation waits for a replacement to exist,
    // because dropping it and then failing anyway loses the conversation for nothing.
    hintRecoveryRejections(selection.decision.rejected, deps.recovery, model, clock.now())
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

    // Injected clock: identical recorded bodies convert to identical bytes.
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

  return {
    async dispatch(input) {
      const scopedInput = {
        ...input,
        identity: input.identity ?? createRequestIdentity(input.requestId),
      }
      const progress: RequestProgress = {
        startedAt: clock.now(),
        requestStarted: clock.elapsed(),
        model: null,
        bodyReadMs: 0,
      }
      const accounting = createRequestAccounting(
        scopedInput,
        progress,
        clock,
        (event) => deps.usage.record(event),
        requestTerminalObserver(scopedInput, progress, clock, deps.onRequest),
        deps.usage.recordTerminal,
      )
      const lifetime = requestLifetime(scopedInput, deps.activeRequests, accounting)
      try {
        lifetime.assertAvailable()
        const response = await serve(
          { ...lifetime.input, identity: scopedInput.identity },
          progress,
          lifetime,
        )
        accounting.respond(response)
        return response
      } catch (error) {
        const { error: failure } = lifetime.fail(error)
        throw failure
      }
    },
  }
}
