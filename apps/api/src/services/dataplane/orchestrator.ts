import { noteRequestFacts } from "../../errors/router-object"
import type { FailoverOptions } from "../routing"
import { createRequestIdentity, type UsageRequestIdentity } from "../usage/request-identity"
import { admitRoutingModel, refuseEncodedBody } from "./body/preflight"
import { DEFAULT_SESSION_HEADERS, resolveSessionKey } from "./body/session"
import { readTrackedRequestBody } from "./body-progress"
import { runChain } from "./chain"
import { preflightRefusal } from "./chain-preparation"
import { countTokensEstimateResponse } from "./count-estimate"
import type { Dispatcher, DispatcherDeps, DispatchInput } from "./dispatcher-config"
import { keyRateLimitedError } from "./limits"
import type { RequestProgress } from "./observe"
import { planCandidates } from "./plan"
import { createRequestRecovery } from "./recovery-wait"
import { costRequested } from "./relay-cost-optin"
import { createRequestAccounting, type RequestAccounting } from "./request-accounting"
import { requestLifetime } from "./request-lifetime"
import { requestSelector } from "./request-select"
import { requestTerminalObserver } from "./request-terminal"
import { createRotationCounters } from "./rotation"
import { ROUTER_ATTEMPTS_HEADER, withHeaders } from "./router-headers"
import { createRuntime } from "./runtime"
import { sharedRuntimeInput } from "./runtime-shared"
import { sessionBindings } from "./session-binding"
import { createTranslatedRequestBody } from "./translate-body"
import { createTranslationDropLog, dropReporter } from "./translation-drop-log"
import { SYSTEM_CLOCK } from "./types"
import { emptyChainOutcome } from "./unservable-scope"

/**
 * The request lifecycle, steps 3-12 of `docs/idea/01-architecture.md`:
 *
 *     read routing fields -> resolve session -> health snapshot -> select -> plan egress
 *                         -> attempt chain -> relay
 *
 * Preflight reads the body once, resolves the session binding (indexed lookup when cold), and
 * selects from a warm snapshot. Every authenticated refusal is accounted for; unknown facts stay
 * null and no account is charged for preparation.
 *
 * One chain can end without an upstream: a scope holding nothing but Claude subscriptions cannot be
 * asked for a token count — the Agent SDK states no such call — so the router answers with its own
 * labelled estimate instead of a refusal (`count-estimate.ts`).
 */

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
  // The runtime fields every request shares, built once per dispatcher.
  const shared = sharedRuntimeInput(deps, options, clock, call)
  // Per pool, per replica, in memory — the caller-owned half of `round-robin` (`rotation.ts`).
  const rotation = createRotationCounters()
  const dropLog = createTranslationDropLog({
    windowMs: options.translationDropLogWindowMs,
    now: () => clock.elapsed(),
  })

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
    // Read again at relay time; asked here so an unknown option is refused before any upstream.
    costRequested(input.request.headers)

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
        ? await bindings.read(input.key.id, session.key, input.key.scope)
        : undefined
    input.request.signal.throwIfAborted()

    const log = deps.logger?.child({ component: "transport", requestId: input.requestId })
    // One wait budget and a lease held while a chain runs, so a waiting request stays active.
    const recovery = createRequestRecovery({
      options: options.recoveryWait,
      clock,
      sleep: deps.sleep,
      signal: input.request.signal,
      log,
      lease: input.activeRequest,
      probing: deps.recovery?.probing?.bind(deps.recovery),
      // A deliberate wait is not router work: it stays out of `router_overhead_seconds` (12.4).
      onWaited: (milliseconds) => {
        progress.recoveryWaitMs += milliseconds
      },
    })
    const runtime = createRuntime({
      ...shared,
      ...(recovery.lease === undefined ? {} : { activeRequest: recovery.lease }),
      ...(deps.sessions === undefined || session.source === "unbound"
        ? {}
        : { sessions: deps.sessions }),
      sessionKeySource: session.source,
      clientToolLoop: session.clientToolLoop,
      bodyReadMs: progress.bodyReadMs,
      recoveryWaitMs: () => progress.recoveryWaitMs,
      record: accounting.record,
      recordTerminal: accounting.recordTerminal,
      selectTerminal: accounting.selectTerminal,
      // Two different ids on purpose: the correlation id is router-owned and joins this
      // request's attempts, while the client's own id is a trace label a caller may repeat or
      // forge. Using the latter as the join key would merge two clients' chains.
      correlationId: input.identity.correlationId,
      requestId: input.requestId,
      clientRequestId: input.identity.clientRequestId,
      apiKeyId: input.key.id,
      sessionKey: session.key,
      model,
      ingressDialect: input.ingress,
      operation,
      requestStarted,
    })

    const fail = preflightRefusal(runtime, startedAt, requestStarted)

    // Scope intersection, filtering, and policy — one pure call over an injected snapshot.
    const select = requestSelector({
      catalog: deps.recovery?.catalog ?? deps.catalog,
      health: deps.health,
      recovery: deps.recovery,
      clock,
      rotation,
      selection: options.selection,
      request: {
        sessionKey: session.key,
        model,
        keyScope: input.key.scope,
        binding,
      },
    })

    // Injected clock: identical recorded bodies convert to identical bytes.
    const translation = {
      created: Math.floor(startedAt.getTime() / 1000),
      model,
      fallbackId: input.requestId,
      defaultMaxTokens: options.translation?.defaultMaxTokens,
      maximumPendingBytes: options.translation?.maximumPendingBytes,
      thinkingDefaultModels: options.translation?.thinkingDefaultModels,
    }
    // `warn`: the caller was answered without something it sent (06-protocol-translation.md).
    const translated = createTranslatedRequestBody(
      body.bytes,
      translation,
      dropReporter(dropLog, log, input.key.id),
    )

    // Loops only while the router's own recovery hold is the obstacle (`recovery-wait.ts`).
    for (;;) {
      const selection = await recovery.select(select)
      // Whether the model resolved against the catalog: the request metric labels an unknown one
      // `other`, since a client-typed string is unbounded.
      progress.modelKnown =
        selection.ok ||
        selection.decision.rejected.some((entry) => entry.reason !== "model-unsupported")
      progress.pools = selection.decision.groups
        .map((group) => group.poolName)
        .filter((name): name is string => name !== null)
      // A `blocked` binding is kept: its account returns on a clock (`invalidated`: see below).
      if (!selection.ok) return fail(selection.error)

      const plan = planCandidates(selection.candidates, deps.catalog, input.ingress, operation)
      if (plan.servable.length === 0) {
        const outcome = emptyChainOutcome({
          plan,
          decision: selection.decision,
          candidates: selection.candidates,
          catalog: deps.catalog,
          operation,
          ingress: input.ingress,
          now: clock.now(),
        })
        if (outcome.kind !== "estimate") return fail(outcome.error)
        // A scope holding nothing but Claude subscriptions has no provider to ask for a count: the
        // Agent SDK states no such call. The router answers for itself, and says so in the body.
        // No relay owns this response, so the request's lease ends here — the held wrapper would
        // keep it, since no chain ever settled it (02.3).
        const estimate = countTokensEstimateResponse(body.bytes, runtime, startedAt, requestStarted)
        input.activeRequest?.release()
        return estimate
      }

      // Kept: the transcript follows the turn to whichever subscription serves it
      // (`claude-sdk/session-carry.ts`), whose `remember` re-points the row once it has answered.
      const decidedBinding = selection.decision.binding
      if (decidedBinding.state === "invalidated") {
        deps.logger?.info("session binding refused", {
          component: "dataplane",
          requestId: input.requestId,
          accountId: decidedBinding.accountId,
          reason: decidedBinding.reason,
        })
      }

      // The bound account travels into the chain so a mid-chain hop off it is known (`leavingBound`).
      const failover: FailoverOptions = {
        ...options.failover,
        ...(decidedBinding.state === "honored" ? { boundAccountId: decidedBinding.accountId } : {}),
      }

      // A restart is stamped by the chain, which alone knows if it carried (`chain-success.ts`).
      const response = await recovery.chain(
        () =>
          runChain({
            modelMetadata: deps.modelMetadata,
            runtime,
            plan: plan.servable,
            request: input.request,
            bodyBytes: body.bytes,
            modelSpan: body.fields.modelSpan,
            streamRequested: body.fields.stream,
            translation,
            translated,
            failover,
            ...(decidedBinding.state === "invalidated"
              ? { bindingRefused: decidedBinding.reason }
              : {}),
            log,
            ...(options.log?.reasonMaxChars === undefined
              ? {}
              : { reasonMaxChars: options.log.reasonMaxChars }),
          }),
        fail,
        plan.servable.map((entry) => entry.account.id),
      )
      if (response !== "retry") return response
    }
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
        recoveryWaitMs: 0,
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
        return withHeaders(response, {
          [ROUTER_ATTEMPTS_HEADER]: String(accounting.answeredAttempts(response)),
        })
      } catch (error) {
        const { error: failure } = lifetime.fail(error)
        noteRequestFacts(failure, { ...accounting.facts(), pools: progress.pools ?? [] })
        throw failure
      }
    },
  }
}
