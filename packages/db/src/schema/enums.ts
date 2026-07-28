import {
  AccountBilling,
  AccountStatus,
  KeyScope,
  ProviderId,
  ResetSource,
  RoutingPolicy,
  UtilizationSource,
} from "@multi-ai-router/core"
import { pgEnum } from "drizzle-orm/pg-core"

/**
 * Postgres enums are for the genuinely closed sets — the ones where an unknown
 * value is a bug and a migration is the right gate on changing them. Sets that
 * only *label* something a provider reports (a quota window kind, how an attempt
 * ended) are `text` columns typed against core instead, so observing a new
 * value is a core-only change with no migration. See `quotaWindows.window` and
 * `usageRecords.outcome`.
 *
 * Every enum that also exists in `@multi-ai-router/core` is built from that
 * package's Zod `.options` array, so the Postgres type and the validated domain
 * type cannot drift: adding a value in core is the only way to add one here.
 *
 * The cast is the whole reason this helper exists — Zod v4 types `.options` as
 * a plain array, while `pgEnum` needs a non-empty tuple. The values are the
 * same array either way; only the static shape is restated.
 */
function pgEnumFrom<T extends string>(name: string, values: readonly T[]) {
  return pgEnum(name, values as [T, ...T[]])
}

/** Static, code-defined registry — there is no provider table. */
export const providerId = pgEnumFrom("provider_id", ProviderId.options)

/**
 * `cooling_down` is clock-recoverable; `exhausted` is not and is never retried
 * on a timer. Never collapse the two.
 */
export const accountStatus = pgEnumFrom("account_status", AccountStatus.options)

/**
 * How an Account is billed, which is the only input to whether its usage prices
 * as real spend or as an attribution. Per account, not per provider: z.ai, Kimi
 * and MiniMax sell a flat-fee coding plan under the same endpoint and key shape
 * as their metered API.
 */
export const accountBilling = pgEnumFrom("account_billing", AccountBilling.options)

/** The six pool policies. `sticky` is the default — see `DEFAULT_ROUTING_POLICY` in core. */
export const routingPolicy = pgEnumFrom("routing_policy", RoutingPolicy.options)

/** `all` | `pools` | `accounts`. Enforced as an intersection, never widened. */
export const keyScope = pgEnumFrom("key_scope", KeyScope.options)

/**
 * Continuous reads a real percentage at any point in a window; threshold-triggered
 * is an alarm that reports nothing until consumption nears the limit. Ranking
 * accounts on a threshold-triggered signal degrades `quota-aware` to round-robin,
 * so the distinction is carried on every row rather than flattened into a number.
 */
export const utilizationSource = pgEnumFrom("utilization_source", UtilizationSource.options)

/** How trustworthy a reset timestamp is. Always displayed with the countdown. */
export const resetSource = pgEnumFrom("reset_source", ResetSource.options)

/**
 * Not in core: cost accounting is a db/usage concern. Subscription accounts are
 * a flat monthly fee, so their per-request cost is an attribution (`notional`),
 * never a charge — the two totals are displayed separately and never summed.
 */
export const costBasis = pgEnum("cost_basis", ["metered", "notional", "unknown"])
export type CostBasis = (typeof costBasis.enumValues)[number]

/** Not in core: the scheduler's task list is a db/scheduler concern. */
export const scheduledTask = pgEnum("scheduled_task", [
  "janitor_sweep",
  "usage_rollup",
  "oauth_state_purge",
  "quota_floor_refresh",
  "config_dir_reap",
  "admin_session_purge",
  "idle_account_probe",
  "model_catalog_refresh",
])

export const scheduledTaskOutcome = pgEnum("scheduled_task_outcome", [
  "success",
  "failed",
  "partial",
])

/**
 * How an upstream attempt ended. Defined in `@multi-ai-router/core` — it is domain vocabulary the
 * services reason about, not a storage detail — and re-exported here so `usageRecords.outcome` and
 * the package barrel keep naming it from one place.
 */
export { USAGE_OUTCOME_SUCCESS, type UsageOutcome } from "@multi-ai-router/core"
