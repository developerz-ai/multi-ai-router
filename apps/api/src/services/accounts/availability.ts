import type {
  AccountStatus,
  QuotaWindowKind,
  QuotaWindowState,
  ResetSource,
  UtilizationSource,
} from "@multi-ai-router/core"
import type { AdminResult } from "../admin/result"
import { buildSnapshot, type HealthStore, type RoutingCatalog } from "../dataplane"
import { isWindowSpent } from "../routing"
import type { RecheckService } from "./recheck"
import type { AccountsService } from "./service"
import type { AccountView } from "./view"

/**
 * Overlays what the router currently observes onto what the operator configured.
 *
 * The stored `status` is a setting — `active` or `disabled`, the only two a human sets. Whether
 * an account is *available right now* is a different fact, held in the in-memory health store,
 * and it is the one an operator actually needs on the accounts screen: "why is nothing routing"
 * is never answered by re-reading the row they wrote.
 *
 * A **decorator**, like `services/admin/coherence.ts`, and for the same reason: the CRUD service
 * has no business knowing a health store exists, and it stays testable without one. It is applied
 * to reads only — a write returns the row it just wrote, which is the honest answer to "what did
 * my edit do".
 *
 * **`resetsAt` is always carried with `resetSource`**, never alone. A provider-reported reset and
 * a backoff estimate look identical as timestamps and mean completely different things; a guessed
 * reset rendered as fact is worse than admitting the reset is unknown
 * (docs/idea/05-routing-and-failover.md). `exhausted` has no reset *by definition* — that absence
 * is precisely what separates it from a cooldown, and it is why the console must show "needs
 * top-up" there and never a countdown.
 *
 * **Quota windows are carried per window, never collapsed into one number.** A Claude subscription
 * runs several concurrently on independent clocks, and the account is blocked by whichever one is
 * spent; a single "resets at" would name one of them and silently drop the other four. `spent` is
 * computed with `isWindowSpent` — the same pure function candidate filtering calls — at that
 * function's default threshold. Selection can be handed a different one (`SelectOptions
 * .quotaSpentThreshold`); nothing configures one today, and the day something does, it has to be
 * threaded here too or the console starts disagreeing with the router about which window blocks.
 */

export interface QuotaWindowView {
  readonly window: QuotaWindowKind
  /** `0..1`, or null where the source reported nothing. Absent is normal, not a fault. */
  readonly utilization: number | null
  /** Why a gauge may be empty. A threshold-triggered source reads null for most of a window. */
  readonly utilizationSource: UtilizationSource
  readonly resetsAt: string | null
  /** Always present, so a countdown is never rendered without its qualifier. */
  readonly resetSource: ResetSource
  readonly lastCheckedAt: string
  /** Whether this window is one of the ones currently blocking the account. */
  readonly spent: boolean
}

export interface AccountAvailability {
  /** What the operator set. `active` or `disabled`, and nothing else. */
  readonly configuredStatus: AccountStatus
  /** When this reset is expected. Null when there is none, or none is known. */
  readonly resetsAt: string | null
  /** How much to trust `resetsAt`. Always present, so a countdown is never read bare. */
  readonly resetSource: ResetSource
  /** When an operator last pressed "Re-check now". Null when nobody has, since this process started. */
  readonly lastCheckedAt: string | null
  readonly consecutiveFailures: number
  readonly inFlight: number
  /** Every window this account holds, in the provider's own order. Empty where none are known. */
  readonly quotaWindows: readonly QuotaWindowView[]
}

export interface AvailabilityDeps {
  readonly catalog: RoutingCatalog
  readonly health: HealthStore
  readonly recheck: Pick<RecheckService, "lastCheckedAt">
  readonly now: () => Date
}

export function withAvailability(
  service: AccountsService,
  deps: AvailabilityDeps,
): AccountsService {
  const overlay = (views: readonly AccountView[]): readonly AccountView[] => {
    // One snapshot for the whole list: `buildSnapshot` is the same call the request path makes,
    // so the console cannot disagree with the router about what is available.
    const now = deps.now()
    const snapshot = buildSnapshot(deps.catalog, deps.health, now)
    const live = new Map(snapshot.accounts.map((account) => [account.id, account]))

    return views.map((view) => {
      const observed = live.get(view.id)
      if (observed === undefined) {
        // In the database but not yet in the warm catalog — a refresh is in flight. Report the
        // stored status rather than inventing an availability the router has not formed.
        return view
      }

      const resetsAt = observed.health.cooldownUntil ?? null
      return {
        ...view,
        status: observed.status,
        availability: {
          configuredStatus: view.status,
          resetsAt: resetsAt?.toISOString() ?? null,
          // No instant means nothing to qualify. `unknown` is the honest source, not a default.
          resetSource:
            resetsAt === null ? "unknown" : (observed.health.cooldownSource ?? "unknown"),
          lastCheckedAt: deps.recheck.lastCheckedAt(view.id)?.toISOString() ?? null,
          consecutiveFailures: observed.health.consecutiveFailures,
          inFlight: observed.health.inFlight,
          quotaWindows: (observed.quotaWindows ?? []).map((window) => toWindowView(window, now)),
        },
      }
    })
  }

  const overlayOne = (result: AdminResult<AccountView>): AdminResult<AccountView> => {
    if (!result.ok) return result
    const [view] = overlay([result.value])
    return view === undefined ? result : { ok: true, value: view }
  }

  return {
    ...service,
    list: async (query) => {
      const result = await service.list(query)
      return result.ok ? { ok: true, value: overlay(result.value) } : result
    },
    get: async (id) => overlayOne(await service.get(id)),
  }
}

/**
 * One stored window as the console reads it. `undefined` becomes `null` rather than `0`: a source
 * that reported nothing has said nothing, and a zero would render as a wide-open gauge on an
 * account the provider may already have cut off.
 */
function toWindowView(window: QuotaWindowState, now: Date): QuotaWindowView {
  return {
    window: window.window,
    utilization: window.utilization ?? null,
    utilizationSource: window.utilizationSource,
    resetsAt: window.resetsAt?.toISOString() ?? null,
    resetSource: window.resetSource,
    lastCheckedAt: window.lastCheckedAt.toISOString(),
    spent: isWindowSpent(window, now),
  }
}
