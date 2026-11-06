import type { Dialect, RouterError } from "@multi-ai-router/core"
import { noteRequestFacts } from "../../errors/router-object"
import { PROVIDER_REGISTRY } from "../../providers"
import type { Candidate } from "../routing"
import { type FailoverOptions, selectAccounts } from "../routing"
import { createRequestIdentity, type UsageRequestIdentity } from "../usage/request-identity"
import { admitRoutingModel, refuseEncodedBody } from "./body/preflight"
import { DEFAULT_SESSION_HEADERS, resolveSessionKey } from "./body/session"
import { readTrackedRequestBody } from "./body-progress"
import { runChain } from "./chain"
import { countTokensEstimateResponse } from "./count-estimate"
import type { Dispatcher, DispatcherDeps, DispatchInput } from "./dispatcher-config"
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "./dispatcher-config"
import { resolveEgress } from "./egress/mode"
import { keyRateLimitedError } from "./limits"
import type { RequestProgress } from "./observe"
import { planCandidates } from "./plan"
import { attemptRecord, errorClassOf, outcomeOf } from "./records"
import { hintRecoveryRejections } from "./recovery-hints"
import { createRequestRecovery } from "./recovery-wait"
import { costRequested } from "./relay-cost-optin"
import { createRequestAccounting, type RequestAccounting } from "./request-accounting"
import { requestLifetime } from "./request-lifetime"
import { requestTerminalObserver } from "./request-terminal"
import { createRotationCounters } from "./rotation"
import { ROUTER_ATTEMPTS_HEADER, withHeaders } from "./router-headers"
import { createRuntime } from "./runtime"
import { sessionBindings } from "./session-binding"
import { buildSnapshot } from "./snapshot"
import { createTranslatedRequestBody } from "./translate-body"
import { type RoutableAccount, SYSTEM_CLOCK, type UpstreamOperation } from "./types"
import { unservableOutcome } from "./unservable"

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

/** Dropped fields one log line spells out; bounds one field, not an operator knob. */
const MAX_REPORTED_DROPS = 20

/**
 * Whether an account **could have served** this request's operation, health aside.
 *
 * This is the question the empty chain asks about an account selection held back: its verdict is
 * the answer only if the account would have served the request had it been healthy. An OpenAI
 * account asked to count tokens never could — it states no counting endpoint — so its cooldown
 * says nothing about this request, and the shape gap is the truth.
 *
 * A Claude subscription is the harder case, because **the estimate is not a serving capability**:
 * the Agent SDK states no token-count call, so a subscription can never be asked for a count, awake
 * or cooling. Yet its health still decides the answer when the scope holds nothing but
 * subscriptions — there the estimate *is* this scope's answer, and the subscription's cooldown is
 * what stands between the client and it, so the honest reply is the `429` a clock recovers.
 *
 * Beside any account that states a counting endpoint of its own, the estimate is not the answer at
 * all: the scope has a provider-shaped gap, the request is refused by name, and a subscription's
 * cooldown is not the reason.
 */
function couldHaveServed(input: {
  readonly account: RoutableAccount
  readonly operation: UpstreamOperation
  readonly ingress: Dialect
  /** Whether the router's own estimate is this scope's answer. */
  readonly estimateIsTheAnswer: boolean
}): boolean {
  const mode = resolveEgress(input.ingress, input.account, input.operation).mode
  // A subscription is never addressed upstream for a count: the Agent SDK states no such call, and
  // the router will not forge one. Its health is a verdict on the account, not on the operation.
  if (mode === "estimate") return input.estimateIsTheAnswer
  // Every other account is judged by the egress gate: one that states the endpoint could have
  // served it, and one that does not never could, awake or cooling.
  return mode !== "rejected"
}

/**
 * Whether an account is a Claude subscription — served by the Agent SDK, not over HTTP.
 *
 * Asked of the provider registry rather than of a provider id: "is this account a subscription" is
 * the transport seam, and a comparison on the id would spread a fact the registry already owns.
 */
function isSubscription(account: RoutableAccount): boolean {
  return PROVIDER_REGISTRY[account.driver.provider].transport === "agent-sdk"
}

/**
 * Whether every account the router could have picked for this request is a Claude subscription.
 *
 * The candidates, not the whole scope: an account the operator switched off is not in the running,
 * and the same question the plan asks of them (`plan.estimable`) is asked of the accounts that
 * survived selection. A scope whose live members are all subscriptions has no provider to ask, so
 * the router's own estimate is its answer; a scope holding one OpenAI account beside them has a
 * provider-shaped gap, the estimate is not its answer, and a subscription's cooldown is not the
 * reason the request fails.
 */
function everyCandidateIsASubscription(
  candidates: readonly Candidate[],
  accounts: ReadonlyMap<string, RoutableAccount>,
): boolean {
  return candidates.every((candidate) => {
    const account = accounts.get(candidate.account.id)
    return account !== undefined && isSubscription(account)
  })
}

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
        ? await bindings.read(input.key.id, session.key)
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
    })
    const runtime = createRuntime({
      ...(recovery.lease === undefined ? {} : { activeRequest: recovery.lease }),
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
      clientToolLoop: session.clientToolLoop,
      clock,
      timeoutMs: options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
      ...(options.upstreamStream === undefined ? {} : { streamDeadlines: options.upstreamStream }),
      ...(deps.reasoningSealer === undefined ? {} : { reasoningSealer: deps.reasoningSealer }),
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
    const select = () => {
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
      // Advanced in the read's synchronous step, or concurrent requests share one counter.
      if (selection.decision.binding.state !== "honored") {
        for (const group of selection.decision.groups) rotation.advance(group.poolId)
      }
      hintRecoveryRejections(selection.decision.rejected, deps.recovery, model, clock.now())
      return selection
    }

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
    const translated = createTranslatedRequestBody(body.bytes, translation, (pair, drops) =>
      log?.warn("translation dropped fields", {
        component: "translate",
        ingress: pair.ingress,
        egress: pair.egress,
        dropped: drops.length,
        fields: drops.slice(0, MAX_REPORTED_DROPS).map((drop) => `${drop.field} ${drop.reason}`),
      }),
    )

    // Loops only while the router's own recovery hold is the obstacle (`recovery-wait.ts`).
    for (;;) {
      const selection = await recovery.select(select)
      progress.pools = selection.decision.groups
        .map((group) => group.poolName)
        .filter((name): name is string => name !== null)
      // A `blocked` binding is kept: its account returns on a clock (`invalidated`: see below).
      if (!selection.ok) return fail(selection.error)

      const plan = planCandidates(selection.candidates, deps.catalog, input.ingress, operation)
      if (plan.servable.length === 0) {
        // Off the served path: this second catalog read happens only once the chain is empty.
        const accounts = new Map(deps.catalog.accounts().map((one) => [one.id, one]))
        // Whether the router's own estimate is this scope's answer, decided once per empty chain.
        const estimateIsTheAnswer = everyCandidateIsASubscription(selection.candidates, accounts)
        const outcome = unservableOutcome({
          plan,
          decision: selection.decision,
          capable: (accountId) => {
            const account = accounts.get(accountId)
            if (account === undefined) return false
            return couldHaveServed({
              account,
              operation,
              ingress: input.ingress,
              estimateIsTheAnswer,
            })
          },
          now: clock.now(),
        })
        // A scope holding nothing but Claude subscriptions has no provider to ask for a count: the
        // Agent SDK states no such call. The router answers for itself, and says so in the body.
        if (outcome.kind === "estimate")
          return countTokensEstimateResponse(body.bytes, runtime, startedAt, requestStarted)
        return fail(outcome.error)
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
        // A chain that answered stamped its own count; one that never reached an upstream did not.
        return response.headers.has(ROUTER_ATTEMPTS_HEADER)
          ? response
          : withHeaders(response, { [ROUTER_ATTEMPTS_HEADER]: String(accounting.facts().attempts) })
      } catch (error) {
        const { error: failure } = lifetime.fail(error)
        noteRequestFacts(failure, { ...accounting.facts(), pools: progress.pools ?? [] })
        throw failure
      }
    },
  }
}
