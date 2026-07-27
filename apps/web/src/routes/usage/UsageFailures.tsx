import { createMemo, createUniqueId, For, Show } from "solid-js"
import type { UsageFailureSplit } from "../../lib/api/usage"
import { faultToken, outcomeLabel } from "../../lib/api/usage-recent"
import { groupFailures } from "../../lib/failure-classes"
import { formatCount, formatPercent } from "../../lib/format"
import styles from "./UsageFailures.module.scss"

/**
 * The error rate, taken apart.
 *
 * The tile above this one says "2.4%". That number is true and an operator can
 * do nothing with it, because the three failures this router produces have three
 * different remedies: a spent window comes back on a clock (`429`), a drained
 * balance comes back when a human pays (`402`), and a key whose scope
 * intersected the pool to nothing comes back when the operator widens it
 * (`403`). Reading one percentage, an operator cannot tell "wait" from "go and
 * pay" — which is exactly the conflation CLAUDE.md non-negotiable 7 exists to
 * prevent, and it is worth as much on the screen as it is in the status codes.
 *
 * So every class prints **its own status and its own next action**, and the
 * three above are shown **even at zero**. "Nothing was rate limited today" is an
 * answer; an absent row is a question. Everything else appears only when it
 * happened, biggest first, so a screen full of zeroes never buries the one
 * number that is not.
 *
 * Two presentation rules are load-bearing:
 *
 * - **Colour is never the only carrier.** Each row's dot takes the same
 *   fault token the live feed's dots take, and the class, the status and the
 *   count are all spelt out beside it.
 * - **A share is drawn against the scan's own denominator**, never against the
 *   stitched total in the tiles. The rollup has no per-outcome grain, so the two
 *   numbers come from different reads, and dividing one by the other would
 *   produce a percentage of nothing.
 *
 * Pure and prop-driven: the fetching lives in `UsageRoute`, so what an operator
 * can read off a row is assertable without a network.
 */

export interface UsageFailuresProps {
  readonly failures: UsageFailureSplit
  /** Named in the caption so the counts are never read against the wrong range. */
  readonly windowLabel: string
}

export function UsageFailures(props: UsageFailuresProps) {
  const headingId = createUniqueId()
  const groups = createMemo(() => groupFailures(props.failures.byOutcome))

  return (
    <section aria-labelledby={headingId} class={styles.panel}>
      <header class={styles.head}>
        <h2 class={styles.title} id={headingId}>
          Why requests failed
        </h2>
        <p class={styles.lead}>
          {formatCount(props.failures.errors)} of {formatCount(props.failures.attempts)} attempts ·{" "}
          {props.windowLabel.toLowerCase()}. Rate limited, out of credits and out of scope are three
          different jobs — they are never one number here.
        </p>
      </header>

      {/* A floor, not a total. Said before the rows rather than under them: an operator who
          reads the counts first and the caveat second has already drawn a conclusion. */}
      <Show when={props.failures.partial}>
        <p class={styles.partial}>
          This window reaches further back than the individual attempt rows are kept, so these are
          at least this many — the split is complete, the counts are a floor.
        </p>
      </Show>

      <ul class={styles.rows}>
        <For each={groups()}>
          {(group) => (
            <li class={styles.row}>
              <div class={styles.identity}>
                {/* Decorative: the class and its status are written beside it. */}
                <span
                  aria-hidden="true"
                  class={styles.dot}
                  style={{ "--dot-color": `var(${faultToken(group.klass.fault)})` }}
                />
                <div class={styles.stack}>
                  <span class={styles.label}>{group.klass.label}</span>
                  <span class={styles.status}>
                    {group.klass.status === null ? "various statuses" : group.klass.status}
                  </span>
                </div>
              </div>

              <div class={styles.count}>
                <span class={styles.attempts}>{formatCount(group.attempts)}</span>
                <span class={styles.share}>
                  {formatPercent(group.attempts, props.failures.attempts)} of attempts
                </span>
              </div>

              <p class={styles.hint}>{group.klass.hint}</p>

              {/* Which outcomes made up the class — printed only when the class is not simply
                  its one outcome under another name, so a row never repeats itself. */}
              <Show when={group.outcomes.length > 1}>
                <ul class={styles.outcomes}>
                  <For each={group.outcomes}>
                    {(outcome) => (
                      <li class={styles.outcome}>
                        <span class={styles.outcomeName}>{outcomeLabel(outcome.outcome)}</span>{" "}
                        <span class={styles.outcomeCount}>{formatCount(outcome.attempts)}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}
