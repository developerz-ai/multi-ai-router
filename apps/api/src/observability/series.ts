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
 * Router overhead, seconds. Dense below and just above the 5 ms p99 budget, because that is the
 * number this histogram exists to defend (CLAUDE.md non-negotiable 8) — buckets that start at
 * 50 ms would report every regression as "fine".
 */
const OVERHEAD_BUCKETS = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1] as const

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
     * Always `1`; the label is the whole payload. First in the exposition because it is the line an
     * operator reads first — `router_build_info * on() group_left(version) <anything>` is how a
     * dashboard annotates a graph with the build that produced it, and a `version` label on every
     * other series would multiply the cardinality of all of them to say the same thing once.
     */
    buildInfo: registry.gauge({
      name: "router_build_info",
      help: "Always 1. The version label names the build; join on it to annotate other series.",
      labels: ["version"],
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
