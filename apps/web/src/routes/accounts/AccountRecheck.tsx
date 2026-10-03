import { Show } from "solid-js"
import { Button } from "../../components/Button"
import type { AccountRecoveryView, RecheckResult } from "../../lib/api/accounts"
import { formatRelative, formatTimestamp } from "../../lib/format"
import { useLastRecheck } from "../../lib/queries/accounts"
import styles from "./AccountRecheck.module.scss"

export interface AccountRecheckProps {
  readonly accountId: string
  readonly busy: boolean
  readonly nowMs: number
  /**
   * `availability.lastCheckedAt` from the accounts read — what the *server* remembers, so a cold
   * load and another operator's press both show a time rather than "not checked".
   */
  readonly recovery?: AccountRecoveryView
  readonly lastCheckedAt: string | null
  readonly onRecheck: (id: string) => void
}

/** Durable request progress; issued means awaiting an outcome, not confirmed running. */
export function AccountRecheck(props: AccountRecheckProps) {
  const last = useLastRecheck(() => props.accountId)
  const result = (): RecheckResult | null => (last.isSuccess ? (last.data ?? null) : null)
  // Server-remembered time, used until this tab makes a press of its own.
  const progress = () => props.recovery ?? result()?.recovery
  const checkedAt = (): string | null => result()?.lastCheckedAt ?? props.lastCheckedAt

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
        <Show
          fallback={
            // No durable recovery request has been observed.
            <span class={styles.line}>No recovery requested</span>
          }
          when={checkedAt()}
        >
          {(checked) => (
            <>
              <span class={styles.line}>
                Requested {formatTimestamp(checked())} ({formatRelative(checked(), props.nowMs)})
              </span>
              {/* Only a press from this tab knows whether the cooldown declined it; the read
                  carries the timestamp but not that verdict. */}
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

function recoveryMessage(state: RecheckResult["recovery"]["state"]): string {
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
