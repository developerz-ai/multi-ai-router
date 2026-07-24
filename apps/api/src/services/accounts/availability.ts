import type { AccountStatus, ResetSource } from "@multi-ai-router/core"
import type { AdminResult } from "../admin/result"
import { buildSnapshot, type HealthStore, type RoutingCatalog } from "../dataplane"
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
 */

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
    const snapshot = buildSnapshot(deps.catalog, deps.health, deps.now())
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
