import {
  type AccountStatus,
  QUOTA_WINDOW_SPAN_MS,
  type QuotaWindowKind,
  type QuotaWindowState,
  type ResetSource,
  type UtilizationSource,
  type WindowTokenLimits,
} from "@multi-ai-router/core"
import type { TokenSpanUsage, UsageReadRepository } from "@multi-ai-router/db"
import type { AdminResult } from "../admin/result"
import { buildSnapshot, type HealthStore, type RoutingCatalog } from "../dataplane"
import { isWindowSpent } from "../routing"
import type { RecheckService } from "./recheck"
import type { AccountsService } from "./service"
import type { AccountView } from "./view"

/**
 * Overlays what the router currently observes onto what the operator configured.
 *
 * The stored `status` is mostly a setting — `active` and `disabled` are the two a human sets, plus
 * whatever standing block the router last wrote through so it would survive a restart. Whether an
 * account is *available right now* is a different fact, held in the in-memory health store, and it
 * is the one an operator actually needs on the accounts screen: "why is nothing routing" is never
 * answered by re-reading the row, whoever wrote it. The live breaker wins wherever it has something
 * to say, which is why a cooldown formed a second ago shows even though nothing persisted it.
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

/**
 * How many slices a window's span is divided into for the sparkline.
 *
 * Twelve is enough to show a burst against a steady burn and small enough that a fleet of accounts
 * with five windows each adds a few hundred integers to one admin response. It is a **display**
 * resolution, not a measurement one: the total is the sum of the slices either way, so changing
 * this changes the smoothness of a curve and nothing about the number beside it.
 */
export const QUOTA_WINDOW_SLOTS = 12

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
  /**
   * Tokens the **router itself** recorded for this account inside this window's own span, or null
   * where the window has no span to measure against (`overage`) or no ceiling is configured.
   *
   * Deliberately separate from {@link utilization}: that field is the *provider's* reading and must
   * stay null when the provider said nothing. This is our own measurement, and conflating the two
   * would let a number we computed be read as one Anthropic reported.
   */
  readonly tokensUsed: number | null
  /**
   * The operator's configured ceiling for this window, or null when they set none.
   *
   * **Not a provider fact.** Anthropic publishes no numeric limit, so this is a figure the operator
   * chose and the console labels as such. It never reaches routing.
   */
  readonly tokenLimit: number | null
  /**
   * The same measurement as {@link tokensUsed}, spread across equal slices of the window's span,
   * oldest first — what the console draws as a sparkline beside the bar.
   *
   * Not a second query and not a second number: the total above is the sum of exactly these
   * buckets, so the bar and the curve cannot disagree. Empty where the bar itself is absent.
   *
   * It answers the question a total cannot. A window two-thirds spent in its first hour and one
   * two-thirds spent evenly are the same bar and completely different situations, and only one of
   * them is about to run out.
   */
  readonly tokenSeries: readonly number[]
}

export interface AccountAvailability {
  /**
   * The status as stored, before this process's own health was overlaid.
   *
   * Usually what the operator set — `active` or `disabled` — but not only: a standing block the
   * router formed is written through to the same column so it survives a restart
   * (`services/dataplane/status-writer.ts`), so a freshly booted replica reads `exhausted` or
   * `needs_reauth` here with nothing yet in memory to overlay. Both are true statements about the
   * account; neither is a countdown, which is what the field beside it is for.
   */
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
  /**
   * Reads how many tokens the router itself recorded inside a window's span. Optional: a
   * deployment that wires none simply renders no configured bars, which is the same thing an
   * operator who set no ceilings sees.
   */
  readonly usage?: Pick<UsageReadRepository, "tokensSince">
  readonly catalog: RoutingCatalog
  readonly health: HealthStore
  readonly recheck: Pick<RecheckService, "lastCheckedAt">
  readonly now: () => Date
}

export function withAvailability(
  service: AccountsService,
  deps: AvailabilityDeps,
): AccountsService {
  const overlay = async (views: readonly AccountView[]): Promise<readonly AccountView[]> => {
    // One snapshot for the whole list: `buildSnapshot` is the same call the request path makes,
    // so the console cannot disagree with the router about what is available.
    const now = deps.now()
    const snapshot = buildSnapshot(deps.catalog, deps.health, now)
    const live = new Map(snapshot.accounts.map((account) => [account.id, account]))

    // One query for every (account, window) an operator configured a ceiling for. Accounts with no
    // ceiling contribute no span, so a deployment that configured none pays nothing for this.
    const limits = new Map(
      views.flatMap((view) =>
        view.windowTokenLimits === null || view.windowTokenLimits === undefined
          ? []
          : [[view.id, view.windowTokenLimits] as const],
      ),
    )
    const measured = await measureTokens(deps, limits, live, now)

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
          quotaWindows: (observed.quotaWindows ?? []).map((window) =>
            toWindowView(window, now, limits.get(view.id), measured, view.id),
          ),
        },
      }
    })
  }

  const overlayOne = async (
    result: AdminResult<AccountView>,
  ): Promise<AdminResult<AccountView>> => {
    if (!result.ok) return result
    const [view] = await overlay([result.value])
    return view === undefined ? result : { ok: true, value: view }
  }

  return {
    ...service,
    list: async (query) => {
      const result = await service.list(query)
      return result.ok ? { ok: true, value: await overlay(result.value) } : result
    },
    get: async (id) => overlayOne(await service.get(id)),
  }
}

/**
 * One stored window as the console reads it. `undefined` becomes `null` rather than `0`: a source
 * that reported nothing has said nothing, and a zero would render as a wide-open gauge on an
 * account the provider may already have cut off.
 */
function toWindowView(
  window: QuotaWindowState,
  now: Date,
  limits: WindowTokenLimits | undefined,
  measured: ReadonlyMap<string, TokenSpanUsage>,
  accountId?: string,
): QuotaWindowView {
  const limit = limits?.[window.window] ?? null
  const measurement =
    limit === null ? undefined : measured.get(`${accountId ?? ""}:${window.window}`)
  return {
    window: window.window,
    utilization: window.utilization ?? null,
    utilizationSource: window.utilizationSource,
    resetsAt: window.resetsAt?.toISOString() ?? null,
    resetSource: window.resetSource,
    lastCheckedAt: window.lastCheckedAt.toISOString(),
    spent: isWindowSpent(window, now),
    // Null unless BOTH exist: a count with no ceiling has nothing to be a fraction of, and a
    // ceiling with no measurable span (`overage`) has nothing to count.
    tokensUsed: measurement?.tokens ?? null,
    tokenLimit: limit,
    tokenSeries: measurement?.series ?? [],
  }
}

/**
 * Tokens recorded inside each configured window's own span, keyed `accountId:window`.
 *
 * The span is `resetsAt - QUOTA_WINDOW_SPAN_MS[kind]`, not "the last N hours": a five-hour window
 * resetting in twenty minutes opened 4h40m ago, and measuring from now would count the wrong 4h40m.
 * A window with no reported reset, or no known span, is skipped rather than measured against a
 * start we invented.
 */
async function measureTokens(
  deps: AvailabilityDeps,
  limits: ReadonlyMap<string, WindowTokenLimits>,
  live: ReadonlyMap<string, { readonly quotaWindows?: readonly QuotaWindowState[] }>,
  now: Date,
): Promise<ReadonlyMap<string, TokenSpanUsage>> {
  if (limits.size === 0 || deps.usage === undefined) return new Map()

  const spans: { accountId: string; window: string; since: Date }[] = []
  for (const [accountId, configured] of limits) {
    for (const window of live.get(accountId)?.quotaWindows ?? []) {
      if (configured[window.window] === undefined) continue
      const span = QUOTA_WINDOW_SPAN_MS[window.window]
      if (span === undefined || window.resetsAt === undefined) continue
      const since = new Date(window.resetsAt.getTime() - span)
      // A reset further out than one full span means a clock we do not trust; skip rather than
      // measure a range that starts in the future.
      if (since.getTime() > now.getTime()) continue
      spans.push({ accountId, window: window.window, since })
    }
  }

  // One query for the total *and* the curve: the total is the sum of the slots, so the bar and the
  // sparkline beside it are literally the same numbers and cannot drift apart.
  const rows = await deps.usage.tokensSince(spans, { until: now, slots: QUOTA_WINDOW_SLOTS })
  return new Map(rows.map((row) => [`${row.accountId}:${row.window}`, row]))
}
