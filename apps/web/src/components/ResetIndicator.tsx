import type { AccountStatus, ResetSource } from "@multi-ai-router/core"
import { createMemo, Show } from "solid-js"
import { describeReset, formatAbsolute } from "../lib/reset-countdown"
import { Badge } from "./Badge"
import styles from "./ResetIndicator.module.scss"

export interface ResetIndicatorProps {
  readonly status: AccountStatus
  /** Epoch ms, or null when the provider reported none. */
  readonly resetsAt: number | null
  readonly resetSource: ResetSource
  /** The ticking clock, passed in — nothing here reads a clock itself. */
  readonly nowMs: number
}

/**
 * When an unavailable account comes back.
 *
 * Three rules, all enforced in `describeReset` rather than in this template:
 *
 * - Reset is shown as **absolute time and countdown together**. The countdown
 *   answers "how long"; the absolute time is what gets compared against a log.
 * - The source is always labelled — `reported` or `estimated`. A guessed reset
 *   presented as fact is worse than no reset at all.
 * - An `exhausted` account shows **"needs top-up" and never a countdown**.
 *   There is no clock that fixes it, so rendering one would promise a recovery
 *   that will not happen.
 */
export function ResetIndicator(props: ResetIndicatorProps) {
  const display = createMemo(() =>
    describeReset(
      { status: props.status, resetsAt: props.resetsAt, resetSource: props.resetSource },
      props.nowMs,
    ),
  )

  return (
    <div class={styles.root}>
      <span
        class={display().kind === "needs_topup" ? styles.topUp : styles.text}
        data-kind={display().kind}
      >
        {display().text}
      </span>

      <Show when={display().kind !== "needs_topup" && props.resetsAt !== null}>
        <span class={styles.absolute}>{formatAbsolute(props.resetsAt ?? 0)}</span>
      </Show>

      <Show when={display().qualifier}>
        {(qualifier) => (
          <Badge
            title={
              qualifier() === "reported"
                ? "The provider stated this reset time."
                : "Derived from observed behaviour — not stated by the provider."
            }
            tone={qualifier() === "reported" ? "neutral" : "warn"}
          >
            {qualifier()}
          </Badge>
        )}
      </Show>
    </div>
  )
}
