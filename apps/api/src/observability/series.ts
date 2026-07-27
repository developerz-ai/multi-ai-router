import { createRegistry, type Registry, type RegistryOptions } from "./registry"

/**
 * Every series this router exports, declared in one place.
 *
 * The list is the table in docs/idea/08-observability.md#metrics plus the five task series under
 * "Scheduled task visibility", and it is kept apart from the code that feeds it so that adding a
 * series is a declaration rather than an edit to the mapping logic. Names, help text, and label
 * sets are the public contract — a dashboard and an alert rule are written against them, so they
 * change like an API changes, not like an internal.
 *
 * **Label discipline** (docs/idea/08-observability.md, "no unbounded label values"): every label
 * here is drawn from a closed enum or from the deployment's own inventory of keys, accounts and
 * pools. `session_id`, `request_id`, model text supplied by a caller for a model that does not
 * exist, and any other client-controlled string stay on the `UsageRecord` and in the logs.
 */

/** Client-facing and upstream latency, seconds. Wide: a long completion is a normal response. */
const LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600] as const

/**
 * Router overhead, seconds. Dense up to and through the 5 ms p99 budget, with a 20ms ceiling to
 * catch severe regressions (4x budget) before hitting +Inf. This histogram exists to defend
 * CLAUDE.md non-negotiable 8 — buckets need to report every regression as distinct, not as "ok".
 */
const OVERHEAD_BUCKETS = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1] as const

/** Background task run time, seconds. A sweep is bounded-batch, so minutes are the outlier. */
const TASK_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300] as const

/**
 * The handles, with their label sets inferred rather than declared. Widening them to a shared
 * `Counter<readonly string[]>` would make `Labels<L>` a plain `Record<string, string>` and hand
 * back exactly the freedom to attach a request id that the compiler is here to remove.
 */
export type RouterSeries = ReturnType<typeof createSeries>

export function createSeries(options: RegistryOptions = {}) {
  const registry: Registry = createRegistry(options)

  return {
    registry,

    /**
     * Always `1`; the labels are the whole payload. First in the exposition because it is the line
     * an operator reads first — `router_build_info * on() group_left(version) <anything>` is how a
     * dashboard annotates a graph with the build that produced it, and a `version` label on every
     * other series would multiply the cardinality of all of them to say the same thing once.
     *
     * `revision` is the second label because a version is not an identity: a rebuilt `:latest`, an
     * rc cut twice and an image built from a dirty tree all report the same one. The sha is what
     * separates them. Two labels, one series — the cardinality is one per process either way.
     */
    buildInfo: registry.gauge({
      name: "router_build_info",
      help: "Always 1. The version and revision labels name the build; join on them to annotate other series.",
      labels: ["version", "revision"],
    }),

    requests: registry.counter({
      name: "router_requests_total",
      help: "Client-facing requests, counted once each on the attempt that ended them.",
      labels: ["ingress_dialect", "model", "key_id", "outcome"],
    }),

    requestDuration: registry.histogram({
      name: "router_request_duration_seconds",
      help: "Client request latency until the response was handed back, upstream time included.",
      labels: ["ingress_dialect", "model", "streamed"],
      buckets: LATENCY_BUCKETS,
    }),

    overhead: registry.histogram({
      name: "router_overhead_seconds",
      help: "Time spent inside the router, excluding upstream. Budgeted at under 5 ms p99.",
      labels: ["ingress_dialect", "path"],
      buckets: OVERHEAD_BUCKETS,
    }),

    upstreamDuration: registry.histogram({
      name: "router_upstream_duration_seconds",
      help: "Wall time of one upstream attempt.",
      labels: ["provider", "account_id", "streamed"],
      buckets: LATENCY_BUCKETS,
    }),

    upstreamAttempts: registry.counter({
      name: "router_upstream_attempts_total",
      help: "Upstream attempts — one per usage record.",
      labels: ["provider", "account_id", "outcome"],
    }),

    tokens: registry.counter({
      name: "router_tokens_total",
      help: "Tokens consumed. input is the uncached remainder; sum all three input directions.",
      labels: ["provider", "account_id", "model", "direction"],
    }),

    /**
     * How much of this deployment's traffic the price table can actually see.
     *
     * Counted per attempt rather than in dollars, because the question it answers is a coverage
     * one: `basis="unknown"` is spend nobody here can report, and a ratio against the other two is
     * the only way an operator learns that a provider they added is invisible in every cost column.
     * A dollar sum would answer it with the very number that is missing.
     *
     * Labelled by provider and model so the answer names what to price next, and so a table that
     * has gone stale against a renamed model family shows up as one model going unknown rather
     * than as a total quietly drifting.
     */
    costBasis: registry.counter({
      name: "router_cost_basis_total",
      help: "Upstream attempts by how they were priced. unknown is spend this deployment cannot see; notional is a subscription attribution, never summed with metered.",
      labels: ["provider", "model", "basis"],
    }),

    /**
     * When the shipped price table was last checked against its vendors, as a Unix timestamp.
     * `time() - router_price_table_asof_timestamp_seconds` is the age, and an age past what a
     * deployment tolerates is the alert — a price table nobody can date is a table nobody can judge.
     */
    priceTableAsOf: registry.gauge({
      name: "router_price_table_asof_timestamp_seconds",
      help: "Unix time the shipped price table was last verified against its vendors. Age is the staleness signal.",
      labels: [],
    }),

    /**
     * When the operator's price overrides were last loaded, or absent before the first successful
     * load. Read beside the gauge above: the shipped table's age says how stale the defaults are,
     * this one says whether the corrections layered over them are arriving at all.
     */
    priceOverridesLoadedAt: registry.gauge({
      name: "router_price_overrides_loaded_timestamp_seconds",
      help: "Unix time the operator's price overrides were last loaded. Absent until the first successful load.",
      labels: [],
    }),

    upstreamErrors: registry.counter({
      name: "router_upstream_errors_total",
      help: "Upstream failures by kind. status is none when the upstream was never reached.",
      labels: ["provider", "account_id", "status", "error_class"],
    }),

    failovers: registry.counter({
      name: "router_failovers_total",
      help: "Times a request moved from one candidate account to the next.",
      labels: ["pool_id", "from_provider", "reason"],
    }),

    accounts: registry.gauge({
      name: "router_accounts",
      help: "Accounts by status. cooling_down and exhausted are distinct and are never summed.",
      labels: ["provider", "status"],
    }),

    quotaUtilization: registry.gauge({
      name: "router_quota_utilization",
      help: "Fraction of a quota window consumed. Absent while the source reports nothing.",
      labels: ["account_id", "window"],
    }),

    quotaReset: registry.gauge({
      name: "router_quota_reset_seconds",
      help: "Seconds until a window resets. Absent for exhausted accounts — there is no reset.",
      labels: ["account_id", "window", "source"],
    }),

    quotaLastChecked: registry.gauge({
      name: "router_quota_last_checked_timestamp_seconds",
      help: "When the utilization above was last refreshed. Read the two together.",
      labels: ["account_id"],
    }),

    usageQueueDepth: registry.gauge({
      name: "router_usage_queue_depth",
      help: "Usage records awaiting batch write. Rising depth is reporting lag, not request lag.",
      labels: [],
    }),

    /**
     * The breaker's own `phase()` (docs/idea/05-routing-and-failover.md), not the stored `status` —
     * `router_accounts{status="cooling_down"}` only implies whether a timer or a human recovers an
     * account, never whether it is still counting down or already eligible for a probe. One series
     * per account per phase, zeroed for the phases it is not in, so an alert on `phase="blocked"`
     * falling to zero is a fact about the account, not a vanished series.
     */
    breakerState: registry.gauge({
      name: "router_breaker_state",
      help: "1 for an account's current circuit-breaker phase (closed, open, half-open, blocked), 0 for the others.",
      labels: ["account_id", "phase"],
    }),

    /**
     * The gate `HealthStore.admitProbe` enforces — see its own doc comment. Sustained `refused` is
     * exactly the traffic the gate exists to describe: a recovering account with more requests
     * queued behind it than the one probe it allows through.
     */
    breakerProbeAdmissions: registry.counter({
      name: "router_breaker_probe_admissions_total",
      help: "Half-open probes admitted vs refused. refused is other requests finding the one probe already taken, not an error.",
      labels: ["result"],
    }),

    /**
     * postgres.js does not expose reserved/idle/waiting counts (`packages/db/src/pool-metrics.ts`),
     * so this counts concurrently in-flight statements instead: below `max` that is exactly the
     * number of connections doing work, and at or beyond it the excess is the driver's own internal
     * queue admitting them one at a time — the same thing it would call `waiting` if it said so.
     */
    dbPoolConnections: registry.gauge({
      name: "router_db_pool_connections",
      help: "Postgres connections by state — in_use, idle, waiting. Approximated from in-flight statements; the fixed pool ceiling is DB_POOL_MAX.",
      labels: ["state"],
    }),

    /**
     * The `claude` subprocess ceiling, seen from inside. Unlabelled by Account on purpose: the thing
     * being bounded is this container's memory, which is one number, and a per-Account series would
     * grow with the inventory to say something the queue depth already says.
     */
    sdkSubprocesses: registry.gauge({
      name: "router_sdk_subprocesses",
      help: "claude subprocesses running now. Against CLAUDE_SDK_MAX_CONCURRENCY, this is memory in use.",
      labels: [],
    }),

    sdkSubprocessQueueDepth: registry.gauge({
      name: "router_sdk_subprocess_queue_depth",
      help: "Subscription requests waiting for a subprocess slot. Sustained depth means raise the ceiling or add a replica.",
      labels: [],
    }),

    usageRecordsDropped: registry.counter({
      name: "router_usage_records_dropped_total",
      help: "Usage records shed on queue overflow. Traffic is unaffected; reporting is behind.",
      labels: [],
    }),

    /**
     * Two dispositions, never summed into one alert: `retried` is a database that blinked and a
     * batch that went back for one more try, `discarded` is rows that no longer exist anywhere.
     * A deployment where the first is noisy and the second is zero is working as designed.
     */
    usageWriteFailures: registry.counter({
      name: "router_usage_write_failures_total",
      help: "Usage records in a batch the database refused. disposition=retried went back for one more try; discarded was lost.",
      labels: ["disposition"],
    }),

    taskLastSuccess: registry.gauge({
      name: "router_task_last_success_timestamp_seconds",
      help: "Unix time of a background task's last successful run. Age beyond its cadence alerts.",
      labels: ["task"],
    }),

    taskDuration: registry.histogram({
      name: "router_task_duration_seconds",
      help: "Background task run time.",
      labels: ["task"],
      buckets: TASK_BUCKETS,
    }),

    taskItems: registry.counter({
      name: "router_task_items_total",
      help: "Items a background task processed — rows deleted, records rolled up, accounts probed.",
      labels: ["task"],
    }),

    taskConsecutiveFailures: registry.gauge({
      name: "router_task_consecutive_failures",
      help: "Consecutive failed runs of a background task. Resets to zero on success.",
      labels: ["task"],
    }),

    taskRuns: registry.counter({
      name: "router_task_runs_total",
      help: "Background task runs by outcome. skipped_locked is normal, not an error.",
      labels: ["task", "outcome"],
    }),
  }
}
