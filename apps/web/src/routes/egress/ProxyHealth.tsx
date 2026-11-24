import { Show } from "solid-js"
import { Badge } from "../../components/Badge"
import type { EgressAssignment } from "../../lib/api/egress"
import { formatMillis, formatRelative, formatTimestamp } from "../../lib/format"
import styles from "./egress.module.scss"
import { outcomeBadge, repairNote } from "./egress-copy"

/** What the router's own checks say about one account's proxy. */
export function ProxyHealth(props: {
  readonly assignment: Pick<EgressAssignment, "replace" | "health">
  readonly nowMs: number
}) {
  const health = () => props.assignment.health
  const badge = () => outcomeBadge(health().outcome)

  return (
    <div class={styles.stack}>
      <span>
        <Badge title={badge().hint} tone={badge().tone}>
          {badge().label}
        </Badge>
      </span>
      <Show when={health().lastCheckedAt}>
        {(at) => (
          <span class={styles.sub} title={formatTimestamp(at())}>
            checked {formatRelative(at(), props.nowMs)}
            {health().latencyMs === null ? "" : ` · ${formatMillis(health().latencyMs)}`}
          </span>
        )}
      </Show>
      <Show when={health().consecutiveFailures > 0}>
        <span class={styles.warn}>
          {health().consecutiveFailures} failed check
          {health().consecutiveFailures === 1 ? "" : "s"} in a row · last ok{" "}
          {formatRelative(health().lastOkAt, props.nowMs)}
        </span>
      </Show>
      <Show when={repairNote(props.assignment)}>
        {(note) => <span class={styles.warn}>{note()}</span>}
      </Show>
      <Show when={health().lastSwapAt}>
        {(at) => (
          <span class={styles.sub} title={formatTimestamp(at())}>
            replaced {formatRelative(at(), props.nowMs)} · {health().swaps} in all
          </span>
        )}
      </Show>
    </div>
  )
}
