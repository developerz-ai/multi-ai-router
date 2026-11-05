import type { Logger } from "../../logging/logger"
import type { RateLimitSignal, UpstreamFailureKind } from "../../providers"
import { describeProvider } from "../accounts/providers"
import { type AccountSnapshot, type Candidate, resolveModel } from "../routing"
import { recoveryAwaitsProbe } from "../routing/recovery-filter"
import { failoverKind } from "./attempt"
import { breakerOptionsFor, type HealthStore } from "./health"
import { accountHealthFacts, type HealthObservation } from "./health-observation"
import type { RecoveryAccess, RecoveryAttempt } from "./recovery-access"
import type { RecoveryCapability } from "./recovery-capability"
import type { Reach } from "./recovery-reach"
import type { RoutableAccount } from "./types"

/**
 * The router's own recovery probe. A permit used to settle only when a client request spent it, so
 * an account with no traffic — or a client backing off past `RECOVERY_MAXIMUM_OUTCOME_MS` — saw every
 * re-check end `uncertain` and stayed out of rotation (prod, 2026-11-05: zai and MiniMax). Now a
 * permit nobody took within the request wait budget is spent by one minimal request the router sends
 * itself, and a failed or uncertain recovery past `nextAllowedAt` on a reachable account is reopened
 * without a client.
 *
 * Bounded by construction: one offer per installed permit (one permit per generation), consumed
 * through the same designated start guard a client request uses, so a client that takes the permit
 * first leaves the router nothing to send. Nothing is offered or sent once issuance closes. A failed
 * probe strikes the breaker, whose running clock `recoveryAwaitsProbe` respects before any reopen. Two
 * cases stop further offers to an account until its lifecycle changes (a re-check, a credential or
 * status edit) or the process restarts: its transport refuses before admission, or the upstream
 * refuses the probe's own request (`client-error`, `model-unsupported`), which settles `uncertain`.
 */

/** What one router-sent probe came back with. */
export type RecoveryProbeResult =
  /** The provider answered (or the attempt failed on the wire). */
  | {
      readonly kind: "answered"
      readonly ok: boolean
      readonly failureKind?: UpstreamFailureKind
      readonly message: string
    }
  /** The permit's start guard refused: a client took the permit, or the account changed. */
  | { readonly kind: "declined" }
  /** The transport refused before admission: this account cannot be probed as configured. */
  | { readonly kind: "refused"; readonly reason: string }

export type RecoveryProbeSend = (input: {
  readonly accountId: string
  readonly model: string
  readonly startGuard: () => Promise<void>
  /** The probe's rate-limit reading, folded only after its verdict (`chain-recovery.ts` order). */
  readonly rateLimitSink: (signal: RateLimitSignal) => void
}) => Promise<RecoveryProbeResult>

export interface RecoveryProbeDeps {
  readonly access: RecoveryAccess
  readonly accounts: () => readonly RoutableAccount[]
  readonly readAccount: (id: string) => RoutableAccount | undefined
  readonly available: (id: string) => RecoveryCapability | undefined
  /** The coordinator still issues: false from the shutdown signal on. */
  readonly issuing: () => boolean
  /** What some usable router key can route to (`recovery-reach.ts`). */
  readonly reach: () => Promise<Reach>
  readonly health: Pick<
    HealthStore,
    "captureAttempt" | "recordSuccess" | "recordFailure" | "applyRateLimit"
  >
  /** Each provider's default probe model, used only when an account declares no models of its own. */
  readonly models: Readonly<Record<string, string>>
  /** `RECOVERY_REQUEST_WAIT_MS`: a client already waiting for the permit gets it first. */
  readonly graceMs: number
  readonly quotaSpentThreshold: number
  readonly schedule: (work: () => void, delayMs: number) => () => void
  readonly now: () => Date
  readonly log: Pick<Logger, "info" | "warn">
}

export function createRecoveryProbe(deps: RecoveryProbeDeps) {
  let send: RecoveryProbeSend | undefined
  // Per account, so bounded by the account count, never by uptime.
  const offered = new Map<string, string>()
  const timers = new Map<string, () => void>()
  const unprobeable = new Map<string, number>()
  const probeable = (account: RoutableAccount) =>
    unprobeable.get(account.id) !== account.lifecycleVersion

  const run = async (capability: RecoveryCapability, sender: RecoveryProbeSend) => {
    const id = capability.accountId
    if (!deps.issuing() || deps.available(id)?.permitId !== capability.permitId) return
    const account = deps.readAccount(id)
    const live = deps.access.currentSnapshot(id)
    if (account === undefined || live?.recovery?.generation !== capability.generation) return
    const choice = probeModel(live, deps.models)
    if (choice === undefined) return
    const { model } = choice
    const candidate: Candidate = {
      account: live,
      poolId: null,
      weight: live.weight,
      priority: live.priority,
      order: 0,
      upstreamModel: model,
      halfOpen: true,
      recoveryPermit: true,
    }
    const attempt = deps.access.prepare(account, candidate, deps.quotaSpentThreshold)
    const guard = attempt.beforeUpstreamStart
    if (!attempt.designated || guard === undefined) return
    const observation = deps.health.captureAttempt(id, accountHealthFacts(account))
    let reading: RateLimitSignal | null = null
    let result: RecoveryProbeResult | undefined
    try {
      result = await sender({
        accountId: id,
        model,
        startGuard: async () => guard(),
        rateLimitSink: (signal) => {
          reading = signal
        },
      })
    } finally {
      if (attempt.started()) {
        if (settle(deps, account, attempt, observation, result) === "request-refused")
          modelRefused(account, choice, result)
        deps.health.applyRateLimit(id, reading, deps.now(), observation)
      } else if (result !== undefined) {
        notSent(account, result)
      }
    }
  }

  /**
   * Our own one-line ping was refused as a request (prod 2026-11-05: MiniMax `404 The model
   * "MiniMax-M2" is no longer available`, read as `succeeded`). The endpoint answered, which proves
   * nothing about serving; re-probing with the same model would only be refused again.
   */
  const modelRefused = (
    account: RoutableAccount,
    choice: ProbeModel,
    result: RecoveryProbeResult | undefined,
  ) => {
    unprobeable.set(account.id, account.lifecycleVersion)
    deps.log.warn("router recovery probe was refused as a request; settled uncertain", {
      accountId: account.id,
      model: choice.model,
      modelSource: choice.source,
      signal: result?.kind === "answered" ? result.message : undefined,
    })
  }

  const notSent = (account: RoutableAccount, result: RecoveryProbeResult) => {
    if (result.kind === "declined") {
      deps.log.info("router recovery probe declined at admission; nothing sent", {
        accountId: account.id,
      })
      return
    }
    // The guard never ran, so no permit was spent: re-offering would only refuse again.
    unprobeable.set(account.id, account.lifecycleVersion)
    deps.log.warn("router recovery probe cannot reach this account; client traffic only", {
      accountId: account.id,
      reason: result.kind === "refused" ? result.reason : result.message,
    })
  }

  return {
    /** Wired once the transport exists; until then permits wait for clients as before. */
    attach(next: RecoveryProbeSend): void {
      send = next
    },
    /** Called as a permit installs; idempotent per permit. */
    offer(capability: RecoveryCapability): void {
      const sender = send
      const id = capability.accountId
      const account = deps.readAccount(id)
      if (
        sender === undefined ||
        !deps.issuing() ||
        account === undefined ||
        !probeable(account) ||
        offered.get(id) === capability.permitId
      )
        return
      offered.set(id, capability.permitId)
      timers.get(id)?.()
      const cancel = deps.schedule(() => {
        if (timers.get(id) === cancel) timers.delete(id)
        run(capability, sender).catch((error) =>
          deps.log.warn("router recovery probe failed before a verdict", {
            accountId: id,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }, deps.graceMs)
      timers.set(id, cancel)
    },
    /** Each coordinator tick: request a recovery for every reachable account only a probe can bring back. */
    async reopen(): Promise<void> {
      if (send === undefined || !deps.issuing()) return
      const now = deps.now()
      const due = deps.accounts().filter((account) => {
        const live = deps.access.currentSnapshot(account.id)
        return (
          live !== undefined &&
          probeable(account) &&
          recoveryAwaitsProbe(live, now, deps.quotaSpentThreshold) &&
          probeModel(live, deps.models) !== undefined
        )
      })
      if (due.length === 0) return
      let reach: Reach
      try {
        reach = await deps.reach()
      } catch (error) {
        deps.log.warn("router recovery reopen skipped: key reach unavailable", {
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      for (const account of due)
        if (reach === "all" || reach.has(account.id))
          deps.access.hint(account.id, "cooldown-expired")
    },
    /** Shutdown signal: no grace timer may fire into a draining process. */
    close(): void {
      for (const cancel of timers.values()) cancel()
      timers.clear()
    },
    forget(accountId: string): void {
      offered.delete(accountId)
      unprobeable.delete(accountId)
      timers.get(accountId)?.()
      timers.delete(accountId)
    },
  }
}

/**
 * The verdict first, as the client path records it; the caller folds the reading after.
 *
 * Unlike a client's request (`chain-recovery.ts`, where a `client-error` proves the account
 * served), a refusal of the router's own ping proves only that the endpoint answered: its model or
 * body is wrong for this account. That settles `uncertain` with no health verdict either way, never
 * `succeeded`, and never `failed` (the breaker does not strike a refused request).
 */
function settle(
  deps: Pick<RecoveryProbeDeps, "health" | "now">,
  account: RoutableAccount,
  attempt: RecoveryAttempt,
  observation: HealthObservation,
  result: RecoveryProbeResult | undefined,
): "settled" | "request-refused" {
  if (result?.kind !== "answered") {
    // Spent at the start guard with no verdict back: the call may have reached the provider.
    attempt.finish("uncertain")
    return "settled"
  }
  const kind = result.ok ? null : failoverKind(result.failureKind ?? null, 0)
  if (kind === "client-error" || kind === "model-unsupported") {
    attempt.finish("uncertain")
    return "request-refused"
  }
  if (kind === null) {
    attempt.finish("succeeded")
    deps.health.recordSuccess(account.id, observation)
    return "settled"
  }
  attempt.finish("failed")
  const authKind = describeProvider(account.driver.provider).authKind
  deps.health.recordFailure(
    account.id,
    { kind, message: "router recovery probe failed" },
    deps.now(),
    { ...(authKind === null ? {} : breakerOptionsFor(authKind)), recoveryProbe: true },
    observation,
  )
  return "settled"
}

interface ProbeModel {
  readonly model: string
  readonly source: "declared" | "provider-default"
}

/**
 * The first model the account itself declares (the operator's order), and the provider's default
 * only when it declares none: a shipped default goes stale when a vendor retires a model (prod
 * 2026-11-05: `MiniMax-M2`), while the declared list is what this account routes today.
 */
function probeModel(
  account: AccountSnapshot,
  models: Readonly<Record<string, string>>,
): ProbeModel | undefined {
  const declared = account.supportedModels?.find((model) => resolveModel(account, model).supported)
  if (declared !== undefined) return { model: declared, source: "declared" }
  const fallback = models[account.provider]
  if (fallback !== undefined && resolveModel(account, fallback).supported)
    return { model: fallback, source: "provider-default" }
  return undefined
}
