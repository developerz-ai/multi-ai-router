import type { AccountStatus, ResetSource } from "@multi-ai-router/core"
import { createMemo, Index, Show } from "solid-js"
import type { QuotaWindowView } from "../lib/api/types"
import { describeQuotaWindows } from "../lib/quota-windows"
import { describeReset, formatAbsolute } from "../lib/reset-countdown"
import { Badge } from "./Badge"
import { QuotaWindowRow } from "./QuotaWindowRow"
import styles from "./ResetIndicator.module.scss"

export interface ResetIndicatorProps {
  readonly status: AccountStatus
  /** Epoch ms, or null when the provider reported none. The account-level breaker cooldown. */
  readonly resetsAt: number | null
  readonly resetSource: ResetSource
  /**
   * Every quota window the router knows about for this account. Empty for a provider that
   * exposes none — a plain API key has one bill and no windows, and inventing rows for it would
   * be worse than showing none.
   */
  readonly quotaWindows?: readonly QuotaWindowView[]
  /** Names the rows for assistive tech, so two accounts' gauges are distinguishable. */
  readonly label: string
  /** The ticking clock, passed in — nothing here reads a clock itself. */
  readonly nowMs: number
}

/**
 * When an unavailable account comes back, **per window**.
 *
 * A Claude subscription runs five quota windows concurrently on independent clocks and is blocked
 * by whichever one is spent, so this renders one row each rather than a single "resets at" that
 * would name one of them and drop the other four. An account with no windows falls back to the
 * account-level line alone, which is the whole story for an API key.
 *
 * The rules — absolute time *and* countdown, a source on every row, no countdown for `exhausted`,
 * no gauge that reads empty without saying why — are decided in `describeQuotaWindows` and
 * rendered by `QuotaWindowRow`, which the usage screen shares. Neither lives in this template.
 *
 * `Index` rather than `For`: the clock ticks once a second and the descriptions are rebuilt with
 * it, so keying by reference would dispose and recreate every row — and every gauge and badge
 * under it — every second, dismissing tooltips mid-read and restarting the fill transition. The
 * window list is positionally stable, so keying by index updates text in place instead.
 */
export function ResetIndicator(props: ResetIndicatorProps) {
  const display = createMemo(() =>
    describeReset(
      { status: props.status, resetsAt: props.resetsAt, resetSource: props.resetSource },
      props.nowMs,
    ),
  )

  const windows = createMemo(() =>
    describeQuotaWindows({ status: props.status, windows: props.quotaWindows ?? [] }, props.nowMs),
  )

  return (
    <div class={styles.root}>
      <div class={styles.summary}>
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

      <Show when={windows().length > 0}>
        <ul class={styles.windows}>
          <Index each={windows()}>
            {(window) => <QuotaWindowRow owner={props.label} window={window()} />}
          </Index>
        </ul>
      </Show>
    </div>
  )
}
