import { Show } from "solid-js"
import { Button } from "../../components/Button"
import type { AccountRecoveryView, RecheckResult } from "../../lib/api/accounts"
import { formatRelative, formatTimestamp } from "../../lib/format"
import { useLastRecheck } from "../../lib/queries/accounts"
import styles from "./AccountRecheck.module.scss"
import { recoveryPresentation } from "./recovery-presentation"

export interface AccountRecheckProps {
  readonly accountId: string
  readonly busy: boolean
  readonly nowMs: number
  /** The catalog projection of the latest durable recovery generation. */
  readonly recovery?: AccountRecoveryView
  /** Database requestedAt for that same generation, including automatic recovery. */
  readonly lastCheckedAt: string | null
  readonly onRecheck: (id: string) => void
}

/** Durable request progress; issued means awaiting an outcome, not confirmed running. */
export function AccountRecheck(props: AccountRecheckProps) {
  const last = useLastRecheck(() => props.accountId)
  const result = (): RecheckResult | null => (last.isSuccess ? (last.data ?? null) : null)
  const presentation = () =>
    recoveryPresentation({ requestedAt: props.lastCheckedAt, recovery: props.recovery }, result())
  const progress = () => presentation().recovery
  const checkedAt = () => presentation().requestedAt

  return (
    <div class={styles.root}>
      <Button
        busy={props.busy}
        onClick={() => props.onRecheck(props.accountId)}
        size="sm"
        tone="neutral"
      >
        Re-check
      </Button>

      {/* Pre-mounted live region, the same shape as ConnectResult: a `role="status"` inserted
          into the DOM together with its own text announces unreliably, so the region wraps the
          slot and every update — the first timestamp, the press verdict — swaps inside it. */}
      <span class={styles.note} role="status">
        <Show when={result()?.checkInProgress}>
          <span class={styles.line}>
            Authentication check in progress — retry{" "}
            {formatRelative(
              result()?.nextAllowedAt ?? new Date(props.nowMs).toISOString(),
              props.nowMs,
            )}
          </span>
        </Show>
        <Show
          fallback={
            // No durable recovery request has been observed.
            <span class={styles.line}>No recovery requested</span>
          }
          when={checkedAt() || result()?.checkInProgress}
        >
          {(_checked) => (
            <>
              <span class={styles.line}>
                <Show when={checkedAt()} fallback="Authentication check in progress">
                  {(at) => (
                    <>
                      Requested {formatTimestamp(at())} ({formatRelative(at(), props.nowMs)})
                    </>
                  )}
                </Show>
              </span>
              {/* Timestamp and progress come from one coherent generation source. */}
              <Show when={progress()}>
                {(recovery) => (
                  <>
                    <span class={styles.line}>{recoveryMessage(recovery().state)}</span>
                    <Show when={new Date(recovery().nextAllowedAt).getTime() > props.nowMs}>
                      <span class={styles.line}>
                        On cooldown — next check{" "}
                        {formatRelative(recovery().nextAllowedAt, props.nowMs)}
                      </span>
                    </Show>
                  </>
                )}
              </Show>
            </>
          )}
        </Show>
      </span>
    </div>
  )
}

function recoveryMessage(state: AccountRecoveryView["state"]): string {
  switch (state) {
    case "pending":
      return "Recovery pending"
    case "issued":
      return "Recovery attempt reserved — awaiting outcome"
    case "succeeded":
      return "Recovery attempt succeeded"
    case "failed":
      return "Recovery attempt failed"
    case "uncertain":
      return "Recovery outcome uncertain"
    case "cancelled":
      return "Recovery cancelled"
  }
}
