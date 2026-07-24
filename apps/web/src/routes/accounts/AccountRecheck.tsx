import { Show } from "solid-js"
import { Button } from "../../components/Button"
import type { RecheckResult } from "../../lib/api/accounts"
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
  readonly lastCheckedAt: string | null
  readonly onRecheck: (id: string) => void
}

/**
 * "Re-check now", per account.
 *
 * What it does and — just as importantly — what it does not:
 *
 * - It clears the breaker marks, so the account becomes eligible again as a
 *   half-open probe. **The next real request is what tests it.** There is no
 *   synthetic probe, so this control has no verdict to report and never says
 *   "healthy again".
 * - `rechecked: false` is a **success**. It means the server-side cooldown
 *   declined the press. It renders as "next check available …", never as an
 *   error — a red state for pressing a button twice would be hostile, which is
 *   why the API does not answer 429 here.
 * - `lastCheckedAt` is **always visible**, pressed or not, so the control is
 *   never a mystery box. It comes from the accounts read, and the press result
 *   supersedes it only because that one also carries `nextAllowedAt`.
 */
export function AccountRecheck(props: AccountRecheckProps) {
  const last = useLastRecheck(() => props.accountId)
  const result = (): RecheckResult | null => (last.isSuccess ? (last.data ?? null) : null)
  // Server-remembered time, used until this tab makes a press of its own.
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

      <Show
        fallback={
          // Genuinely never checked since the router started — the timestamps live in memory
          // alongside the breaker marks they guard. Saying so beats inventing a time.
          <span class={styles.note}>Not checked since restart</span>
        }
        when={checkedAt()}
      >
        {(checked) => (
          <span class={styles.note}>
            <span class={styles.line}>
              Checked {formatTimestamp(checked())} ({formatRelative(checked(), props.nowMs)})
            </span>
            {/* Only a press from this tab knows whether the cooldown declined it; the read
                carries the timestamp but not that verdict. */}
            <Show when={result()}>
              {(pressed) => (
                <Show
                  fallback={
                    <span class={styles.line}>
                      Eligible again — status updates on the next request
                    </span>
                  }
                  when={!pressed().rechecked}
                >
                  <span class={styles.line}>
                    On cooldown — next check {formatRelative(pressed().nextAllowedAt, props.nowMs)}
                  </span>
                </Show>
              )}
            </Show>
          </span>
        )}
      </Show>
    </div>
  )
}
