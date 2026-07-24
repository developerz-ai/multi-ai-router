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
 *   never a mystery box.
 */
export function AccountRecheck(props: AccountRecheckProps) {
  const last = useLastRecheck(() => props.accountId)
  const result = (): RecheckResult | null => (last.isSuccess ? (last.data ?? null) : null)

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
          // No `GET` carries `lastCheckedAt`, so a cold load genuinely does not
          // know. Saying so beats inventing a time.
          <span class={styles.note}>Not checked from this console</span>
        }
        when={result()}
      >
        {(checked) => (
          <span class={styles.note}>
            <span class={styles.line}>
              Checked {formatTimestamp(checked().lastCheckedAt)} (
              {formatRelative(checked().lastCheckedAt, props.nowMs)})
            </span>
            <Show
              fallback={
                <span class={styles.line}>Eligible again — status updates on the next request</span>
              }
              when={!checked().rechecked}
            >
              <span class={styles.line}>
                On cooldown — next check {formatRelative(checked().nextAllowedAt, props.nowMs)}
              </span>
            </Show>
          </span>
        )}
      </Show>
    </div>
  )
}
