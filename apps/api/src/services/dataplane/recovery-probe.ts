import type { UpstreamFailureKind } from "../../providers"
import { describeProvider } from "../accounts/providers"
import { type AccountSnapshot, type Candidate, resolveModel } from "../routing"
import { recoveryAwaitsProbe } from "../routing/recovery-filter"
import { failoverKind } from "./attempt"
import { breakerOptionsFor, type HealthStore } from "./health"
import { accountHealthFacts } from "./health-observation"
import type { RecoveryAccess } from "./recovery-access"
import type { RecoveryCapability } from "./recovery-capability"
import type { RoutableAccount } from "./types"

/**
 * The router's own recovery probe. A permit used to settle only when a client request spent it, so
 * an account with no traffic — or a client backing off past `RECOVERY_MAXIMUM_OUTCOME_MS` — saw every
 * re-check end `uncertain` and stayed out of rotation (prod, 2026-11-05: zai and MiniMax). Now a
 * permit nobody took within the request wait budget is spent by one minimal request the router sends
 * itself, and a failed or uncertain recovery past `nextAllowedAt` is reopened without a client.
 *
 * Bounded by construction: one offer per installed permit (one permit per generation), consumed
 * through the same designated start guard a client request uses, so a client that takes the permit
 * first leaves the router nothing to send. A failed probe strikes the breaker, whose running clock
 * `recoveryAwaitsProbe` respects before any reopen.
 */

/** What one router-sent probe answered. `tested: false` means no provider verdict came back. */
export interface RecoveryProbeResult {
  readonly tested: boolean
  readonly outcome?: "ok" | "failed"
  readonly failureKind?: UpstreamFailureKind
}

export type RecoveryProbeSend = (
  accountId: string,
  model: string,
  startGuard: () => Promise<void>,
) => Promise<RecoveryProbeResult>

export interface RecoveryProbeDeps {
  readonly access: RecoveryAccess
  readonly accounts: () => readonly RoutableAccount[]
  readonly readAccount: (id: string) => RoutableAccount | undefined
  readonly available: (id: string) => RecoveryCapability | undefined
  readonly health: Pick<HealthStore, "captureAttempt" | "recordSuccess" | "recordFailure">
  /** Which model each provider is probed with; the account's own declared list is the fallback. */
  readonly models: Readonly<Record<string, string>>
  /** `RECOVERY_REQUEST_WAIT_MS`: a client already waiting for the permit gets it first. */
  readonly graceMs: number
  readonly quotaSpentThreshold: number
  readonly schedule: (work: () => void, delayMs: number) => () => void
  readonly now: () => Date
  readonly warn: (message: string, error?: unknown) => void
}

export function createRecoveryProbe(deps: RecoveryProbeDeps) {
  let send: RecoveryProbeSend | undefined
  // Last permit offered per account: bounded by the account count, never by uptime.
  const offered = new Map<string, string>()

  const run = async (capability: RecoveryCapability, sender: RecoveryProbeSend) => {
    const id = capability.accountId
    if (deps.available(id)?.permitId !== capability.permitId) return
    const account = deps.readAccount(id)
    const live = deps.access.currentSnapshot(id)
    if (account === undefined || live?.recovery?.generation !== capability.generation) return
    const model = probeModel(live, deps.models)
    if (model === undefined) return
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
    let result: RecoveryProbeResult = { tested: false }
    try {
      result = await sender(id, model, async () => guard())
    } finally {
      // Nothing consumed: a client request took the permit, or admission refused before the wire.
      if (attempt.started()) {
        const kind =
          result.tested && result.outcome === "failed"
            ? failoverKind(result.failureKind ?? null, 0)
            : null
        if (
          result.tested &&
          (kind === null || kind === "client-error" || kind === "model-unsupported")
        ) {
          // The account answered; a refusal of the request itself is not a failed recovery
          // (`chain-recovery.ts`, prod 2026-10-13..15).
          attempt.finish("succeeded")
          deps.health.recordSuccess(id, observation)
        } else if (kind !== null) {
          attempt.finish("failed")
          const authKind = describeProvider(account.driver.provider).authKind
          deps.health.recordFailure(
            id,
            { kind, message: "router recovery probe failed" },
            deps.now(),
            { ...(authKind === null ? {} : breakerOptionsFor(authKind)), recoveryProbe: true },
            observation,
          )
        } else {
          // Spent at the start guard with no verdict back: the call may have reached the provider.
          attempt.finish("uncertain")
        }
      }
    }
  }

  return {
    /** Wired once the transport exists; until then permits wait for clients as before. */
    attach(next: RecoveryProbeSend): void {
      send = next
    },
    /** Called as a permit installs; idempotent per permit. */
    offer(capability: RecoveryCapability): void {
      const sender = send
      if (sender === undefined || offered.get(capability.accountId) === capability.permitId) return
      offered.set(capability.accountId, capability.permitId)
      deps.schedule(() => {
        run(capability, sender).catch((error) =>
          deps.warn("router recovery probe failed before a verdict", error),
        )
      }, deps.graceMs)
    },
    /** Each coordinator tick: request a recovery for every account only a probe can bring back. */
    reopen(): void {
      if (send === undefined) return
      const now = deps.now()
      for (const account of deps.accounts()) {
        const live = deps.access.currentSnapshot(account.id)
        if (
          live === undefined ||
          !recoveryAwaitsProbe(live, now, deps.quotaSpentThreshold) ||
          probeModel(live, deps.models) === undefined
        )
          continue
        deps.access.hint(account.id, "cooldown-expired")
      }
    },
    forget(accountId: string): void {
      offered.delete(accountId)
    },
  }
}

/** The provider's probe model when this account serves it, else the first model it declares. */
function probeModel(
  account: AccountSnapshot,
  models: Readonly<Record<string, string>>,
): string | undefined {
  const preferred = models[account.provider]
  if (preferred !== undefined && resolveModel(account, preferred).supported) return preferred
  return account.supportedModels?.find((model) => resolveModel(account, model).supported)
}
