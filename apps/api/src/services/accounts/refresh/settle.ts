import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { Logger } from "../../../logging/logger"
import type { AuditRecorder } from "../../admin/audit"
import type { RefreshOutcome } from "./exchange"
import { matches, type RefreshExpectation, type RefreshTimerState } from "./identity"
import { retryDelayMs } from "./schedule"
import { auditRevival, parkForReauth, sameObservation, spendParkedRefresh } from "./status"
import type { CredentialRefreshConfig } from "./types"

/** What an exchange's outcome means for the account: retry, park, spend, or return it to service. */
export function createRefreshSettle(deps: {
  readonly accounts: Pick<
    AccountRepository,
    "findById" | "transitionObservedStatus" | "spendAuthRefresh"
  >
  readonly audit: AuditRecorder
  readonly logger: Logger
  readonly now: () => Date
  readonly config: CredentialRefreshConfig
  readonly timings: Map<string, RefreshTimerState>
  readonly barrier: () => Promise<void>
  readonly defer: (id: string, expected: RefreshExpectation, delayMs: number) => void
  readonly disarm: (id: string) => void
  readonly abandoned: () => boolean
}) {
  const { config, timings, barrier, defer, disarm, abandoned } = deps
  const status = {
    ...deps,
    refreshCatalogAfterMutation: barrier,
    canFinalize: () => !abandoned(),
  }
  const superseded = (id: string, expected: RefreshExpectation): RefreshOutcome => {
    defer(id, expected, config.minDelayMs)
    return { kind: "skipped", reason: "superseded" }
  }
  const parked = async (
    latest: AccountRow & { readonly authMaterial: string },
    outcome: Extract<RefreshOutcome, { kind: "failure" }>,
    expected: RefreshExpectation,
  ): Promise<RefreshOutcome> => {
    if ((await spendParkedRefresh(status, latest, outcome.reason)) === undefined)
      return superseded(latest.id, expected)
    deps.logger.warn("parked account's refresh failed; it needs a sign-in", {
      component: "account-refresher",
      accountId: latest.id,
      reason: outcome.reason,
    })
    return outcome
  }
  return async (
    id: string,
    outcome: RefreshOutcome,
    expected: RefreshExpectation,
    signal: AbortSignal,
  ): Promise<RefreshOutcome> => {
    if (outcome.kind === "success") {
      if (!abandoned()) await barrier()
      // A committed revival is audited even past the drain: the row did change.
      if (outcome.revived) {
        await auditRevival(deps, outcome.row)
        deps.logger.info("refresh returned a parked account to service", {
          component: "account-refresher",
          accountId: id,
        })
      }
      return outcome
    }
    if (abandoned()) return outcome
    if (outcome.kind === "skipped") {
      if (
        outcome.reason === "busy" ||
        outcome.reason === "superseded" ||
        outcome.reason === "aborted"
      ) {
        defer(id, expected, config.minDelayMs)
      }
      return outcome
    }
    if (signal.aborted) return { kind: "skipped", reason: "aborted", row: outcome.observed }
    const latest = await deps.accounts.findById(id)
    if (signal.aborted) return { kind: "skipped", reason: "aborted" }
    if (latest === undefined || !sameObservation(latest, outcome.observed)) {
      defer(id, expected, config.minDelayMs)
      return {
        kind: "skipped",
        reason: "superseded",
        ...(latest === undefined ? {} : { row: latest }),
      }
    }
    const timing = timings.get(id)
    const tries = timing !== undefined && matches(timing, latest) ? ++timing.attempts : 1
    if (outcome.reason === "unreachable" && tries < config.maxAttempts) {
      defer(id, expected, retryDelayMs(tries, config.minDelayMs))
      return outcome
    }
    if (latest.status === "needs_reauth" && latest.authMaterial !== null)
      return parked({ ...latest, authMaterial: latest.authMaterial }, outcome, expected)
    if (latest.status === "exhausted") {
      if (
        timing === undefined ||
        !matches(timing, latest) ||
        !matches(expected, latest) ||
        timing.lifecycleVersion !== latest.lifecycleVersion
      )
        return { kind: "skipped", reason: "superseded" }
      timing.pausedLifecycleVersion = latest.lifecycleVersion
      disarm(id)
      return outcome
    }
    const committed = await parkForReauth(status, outcome.observed, outcome.reason)
    return committed === undefined ? superseded(id, expected) : outcome
  }
}
