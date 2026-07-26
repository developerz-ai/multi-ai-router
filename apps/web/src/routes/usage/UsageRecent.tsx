import { createSignal, createUniqueId, For, Show } from "solid-js"
import { EmptyState } from "../../components/EmptyState"
import { SelectField, TextField } from "../../components/Field"
import { QueryBoundary } from "../../components/QueryBoundary"
import { TableSkeleton } from "../../components/TableSkeleton"
import {
  RECENT_FILTERS,
  RECENT_LIMIT_DEFAULT,
  RECENT_LIMITS,
  type RecentFilter,
  recentFilterLabel,
} from "../../lib/api/usage-recent"
import { createNow } from "../../lib/clock"
import { useRecentAttempts } from "../../lib/queries/usage-recent"
import { RecentAttemptsTable } from "./RecentAttemptsTable"
import styles from "./UsageRecent.module.scss"

/**
 * The live request feed: the last N upstream attempts, newest first.
 *
 * Every other panel on this screen aggregates. An aggregate answers *how much* and *how often*;
 * this one answers **which request, on which account, and how it ended** — the question an
 * operator arrives with after a tool errored, and the one whose answer used to live only in the
 * process logs, where a container operator cannot reach it.
 *
 * Two properties of the controls are deliberate:
 *
 * - **`quota_exhausted` and `credits_exhausted` are separately selectable**, never one "rate
 *   limited" bucket. One is a window a clock refills; the other is a balance a human refills, and
 *   collapsing them is the mistake the whole status vocabulary exists to prevent.
 * - **The request-id box accepts either id.** The router mints a correlation id, and a client may
 *   have sent its own `x-request-id`. From outside there is no way to know which one an operator
 *   is holding, so asking them to pick would be asking them to guess.
 *
 * This panel owns its query rather than taking rows as props — the same shape `AuditLogSection`
 * has, and for the same reason: the filters belong to the feed, not to the screen around it.
 */
export function UsageRecent() {
  const [limit, setLimit] = createSignal<number>(RECENT_LIMIT_DEFAULT)
  const [filter, setFilter] = createSignal<RecentFilter>("all")
  const [requestId, setRequestId] = createSignal("")
  const headingId = createUniqueId()
  const now = createNow(10_000)

  const trimmedId = () => requestId().trim()
  const page = useRecentAttempts(() => ({
    limit: limit(),
    filter: filter(),
    requestId: trimmedId() === "" ? null : trimmedId(),
  }))

  return (
    <section aria-labelledby={headingId} class={styles.panel}>
      <header class={styles.head}>
        <h2 class={styles.title} id={headingId}>
          Live request feed
        </h2>
        <p class={styles.lead}>
          One row per upstream attempt, newest first, refreshed on its own. A failover chain shows
          as several rows under one request id.
        </p>
      </header>

      <div class={styles.controls}>
        <SelectField
          hint="Quota and credits stay apart: one is a window that resets, the other needs a top-up."
          label="Show"
          onChange={(event) => setFilter(event.currentTarget.value as RecentFilter)}
          options={RECENT_FILTERS.map((value) => ({ value, label: recentFilterLabel(value) }))}
          value={filter()}
        />

        <TextField
          hint="Either the router's own id or the x-request-id your client sent."
          label="Request id"
          onInput={(event) => setRequestId(event.currentTarget.value)}
          placeholder="req-42 or a uuid"
          value={requestId()}
        />

        {/* The same segmented shape the window, dimension and rank-by switchers use, so an
            operator reads all four as one kind of control. */}
        <fieldset class={styles.limits}>
          <legend class={styles.groupLabel}>Attempts shown</legend>
          <For each={RECENT_LIMITS}>
            {(value) => (
              <button
                aria-pressed={limit() === value ? "true" : "false"}
                class={styles.limit}
                onClick={() => setLimit(value)}
                type="button"
              >
                {value}
              </button>
            )}
          </For>
        </fieldset>
      </div>

      <QueryBoundary
        errorTitle="The request feed could not be loaded"
        loading={<TableSkeleton label="Loading recent attempts" rows={5} />}
        query={page}
      >
        {(data) => (
          <Show
            fallback={<EmptyState icon="usage" {...emptyFor(filter(), trimmedId())} />}
            when={data.attempts.length > 0}
          >
            <RecentAttemptsTable attempts={data.attempts} limit={data.limit} nowMs={now()} />
          </Show>
        )}
      </QueryBoundary>
    </section>
  )
}

/** Why the table is empty, in the operator's terms rather than as "no results". */
export function emptyFor(
  filter: RecentFilter,
  requestId: string,
): { readonly title: string; readonly description: string } {
  if (requestId !== "") {
    return {
      title: "No attempt carries that request id",
      description:
        "Either the id came from a different router, or its attempts have aged out of the retention window. Clear the box to see the whole feed.",
    }
  }
  if (filter === "all") {
    return {
      title: "Nothing has been routed yet",
      description:
        "Every request through /v1 lands here within seconds — one row per upstream attempt, with the account that served it and how it ended.",
    }
  }
  return {
    title: "Nothing matches that filter",
    description: `No recent attempt ended in ${recentFilterLabel(filter).toLowerCase()}. Widen it to "Everything" to see what did.`,
  }
}
