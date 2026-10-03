import type { AccountObservation } from "@multi-ai-router/db"
import {
  UpstreamAdmissionRefused,
  type UpstreamStartGuard,
} from "../../providers/upstream-admission"
import type { AutomaticRecoveryRequest, RecoveryCoordinator } from "../recovery"
import {
  type AccountSnapshot,
  type Candidate,
  DEFAULT_QUOTA_SPENT_THRESHOLD,
  findSpentWindow,
} from "../routing"
import { recoveryAllowsQuota, recoveryIsGated } from "../routing/recovery-filter"
import type { HealthStore } from "./health"
import type { createRecoveryCapabilities, RecoveryCapability } from "./recovery-capability"
import { overlayHealth } from "./snapshot"
import type { RoutableAccount, RoutingCatalog } from "./types"

export interface RecoveryAttempt {
  readonly designated: boolean
  started(): boolean
  readonly beforeUpstreamStart?: UpstreamStartGuard
  finish(state: "succeeded" | "failed" | "uncertain"): void
}
export interface RecoveryAccess {
  readonly retryAfterMs: number
  readonly quotaStaleAfterMs: number
  readonly catalog: RoutingCatalog
  currentSnapshot(accountId: string): AccountSnapshot | undefined
  hint(accountId: string, reason: AutomaticRecoveryRequest["reason"]): void
  prepare(
    account: RoutableAccount,
    candidate: Candidate,
    quotaSpentThreshold?: number,
  ): RecoveryAttempt
  forget(accountId: string): void
}
export function createRecoveryAccess(deps: {
  catalog: RoutingCatalog
  readAccount: (id: string) => RoutableAccount | undefined
  coordinator: RecoveryCoordinator
  health: Pick<HealthStore, "stateOf">
  capabilities: ReturnType<typeof createRecoveryCapabilities>
  now: () => Date
  retryAfterMs: number
  quotaStaleAfterMs: number
  quotaSpentThreshold?: number
}): RecoveryAccess {
  const current = deps.readAccount
  const observation = (account: RoutableAccount): AccountObservation => ({
    lifecycleVersion: account.lifecycleVersion,
    authMaterial: account.authMaterial,
    status: account.snapshot.status,
  })
  const hint: RecoveryAccess["hint"] = (accountId, reason) => {
    const account = current(accountId)
    if (account === undefined) return
    deps.coordinator.demand(accountId)
    deps.coordinator.requestAutomatic({
      accountId,
      expected: observation(account),
      expectedRecoveryRevision: account.recovery?.revision ?? null,
      reason,
    })
  }
  return {
    retryAfterMs: deps.retryAfterMs,
    quotaStaleAfterMs: deps.quotaStaleAfterMs,
    catalog: {
      pools: () => deps.catalog.pools(),
      accounts: () =>
        deps.catalog.accounts().map((account) => {
          const recovery = account.snapshot.recovery
          if (recovery === undefined) return account
          const available = deps.capabilities.available(account.id)
          const deadline = Math.max(
            deps.now().getTime() + deps.retryAfterMs,
            recovery.state === "failed" || recovery.state === "uncertain"
              ? recovery.nextAllowedAt.getTime()
              : 0,
          )
          return {
            ...account,
            snapshot: {
              ...account.snapshot,
              recovery: {
                ...recovery,
                localAvailable: available !== undefined,
                retryAt: new Date(deadline),
              },
            },
          }
        }),
    },
    currentSnapshot(id) {
      const account = current(id)
      return account === undefined
        ? undefined
        : overlayHealth(account.snapshot, deps.health.stateOf(id))
    },
    hint,
    prepare(
      account,
      candidate,
      quotaSpentThreshold = deps.quotaSpentThreshold ?? DEFAULT_QUOTA_SPENT_THRESHOLD,
    ) {
      const recovery = candidate.account.recovery
      const gated =
        recovery !== undefined && recovery.state !== "succeeded" && recovery.state !== "cancelled"
      let started = false
      if (!candidate.halfOpen && !gated)
        return {
          started: () => started,
          designated: false,
          beforeUpstreamStart: () => {
            const latest = current(account.id)
            if (
              latest === undefined ||
              latest.lifecycleVersion !== account.lifecycleVersion ||
              latest.authMaterial !== account.authMaterial
            )
              throw new UpstreamAdmissionRefused()
            const live = overlayHealth(latest.snapshot, deps.health.stateOf(account.id))
            if (
              live.status !== "active" ||
              recoveryIsGated(live) ||
              findSpentWindow(live, deps.now(), quotaSpentThreshold) !== null
            )
              throw new UpstreamAdmissionRefused()
            started = true
          },
          finish: () => {},
        }
      if (deps.capabilities.available(account.id) === undefined)
        hint(account.id, "cooldown-expired")
      let consumed: RecoveryCapability | undefined
      return {
        designated: true,
        started: () => consumed !== undefined,
        beforeUpstreamStart: Object.assign(
          () => {
            const latest = current(account.id)
            if (latest === undefined) throw new UpstreamAdmissionRefused()
            const live = overlayHealth(latest.snapshot, deps.health.stateOf(account.id))
            const now = deps.now()
            if (
              live.status === "disabled" ||
              live.status === "exhausted" ||
              live.status === "needs_reauth" ||
              (live.health.cooldownUntil !== undefined && live.health.cooldownUntil > now) ||
              !recoveryAllowsQuota(
                {
                  ...live,
                  recovery:
                    live.recovery === undefined
                      ? undefined
                      : {
                          ...live.recovery,
                          localAvailable: deps.capabilities.available(account.id) !== undefined,
                        },
                },
                now,
                quotaSpentThreshold,
              )
            )
              throw new UpstreamAdmissionRefused()
            const generation = recovery?.generation
            consumed =
              generation === undefined
                ? undefined
                : deps.capabilities.consume(account.id, generation)
            if (consumed === undefined) {
              hint(account.id, "cooldown-expired")
              throw new UpstreamAdmissionRefused()
            }
          },
          { singleStart: true },
        ),
        finish: (state) => {
          if (consumed === undefined) return
          deps.coordinator.recordOutcome({
            accountId: consumed.accountId,
            generation: consumed.generation,
            permitId: consumed.permitId,
            ownershipEpoch: consumed.ownershipEpoch,
            expected: consumed.expected,
            state,
          })
          deps.capabilities.completed(consumed.accountId, consumed.generation, consumed.permitId)
        },
      }
    },
    forget(accountId) {
      deps.capabilities.forget(accountId)
      deps.coordinator.forget(accountId)
    },
  }
}
