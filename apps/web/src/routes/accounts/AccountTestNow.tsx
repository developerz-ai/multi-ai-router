import { createSignal, Show } from "solid-js"
import { Button } from "../../components/Button"
import { ConfirmDialog } from "../../components/ConfirmDialog"
import { TextField } from "../../components/Field"
import type { ProviderTransport } from "../../lib/api/types"
import { formatRelative, formatTimestamp } from "../../lib/format"
import { useLastTest } from "../../lib/queries/accounts"
import styles from "./AccountTestNow.module.scss"

export interface AccountTestNowProps {
  readonly accountId: string
  /** What the confirmation names: an id tells one of six subscriptions from nothing. */
  readonly accountLabel: string
  readonly busy: boolean
  readonly nowMs: number
  /** From `GET /providers` — decides whether a press needs the subprocess confirmation. */
  readonly transport: ProviderTransport | undefined
  readonly onTest: (input: {
    readonly id: string
    readonly model: string
    readonly confirmed?: boolean
  }) => void
}

/**
 * "Test now" — the second, opt-in button beside "Re-check now"
 * (`AccountRecheck.tsx`), and a different kind of answer.
 *
 * A re-check clears breaker marks and reports nothing about whether the account works, because it
 * sends nothing. This button sends one real, minimal completion and reports what actually came
 * back — `outcome: "ok" | "failed"`, plus a short, safe message.
 *
 * **The model is typed by the operator, not guessed.** The router keeps no catalog of what models
 * an upstream serves — discovering one is itself a live request — so the field mirrors what any
 * client would have to name.
 *
 * **A Claude subscription gets a confirmation dialog first.** Pressing "Test" for one does not
 * fire the request; it opens a dialog stating plainly that this spawns a real `claude` subprocess
 * and bills a turn, and only a second, explicit press sends `confirmed: true`. Every other
 * provider's press goes straight through — it costs a token or two of a real quota window, not a
 * subprocess, and CLAUDE.md's confirmation rule is written for the Agent-SDK path specifically.
 */
export function AccountTestNow(props: AccountTestNowProps) {
  const [model, setModel] = createSignal("")
  const [confirming, setConfirming] = createSignal(false)
  const last = useLastTest(() => props.accountId)

  const requiresConfirm = (): boolean => props.transport === "agent-sdk"
  const canSubmit = (): boolean => model().trim().length > 0

  const fire = (confirmed?: boolean): void => {
    props.onTest({ id: props.accountId, model: model().trim(), confirmed })
    setConfirming(false)
  }

  const onPress = (): void => {
    if (!canSubmit()) return
    if (requiresConfirm()) setConfirming(true)
    else fire()
  }

  return (
    <div class={styles.root}>
      <TextField
        class={styles.modelInput}
        label="Model"
        onInput={(event) => setModel(event.currentTarget.value)}
        placeholder="model name"
        value={model()}
      />
      <Button busy={props.busy} disabled={!canSubmit()} onClick={onPress} size="sm" tone="neutral">
        Test now
      </Button>

      {/* Pre-mounted live region, the same shape as ConnectResult: a `role="status"` inserted
          into the DOM together with its own text announces unreliably, so the region wraps the
          slot and the outcome of a press swaps inside it. Empty until the first test runs. */}
      <span class={styles.note} role="status">
        <Show when={last.isSuccess ? last.data : null}>
          {(result) => (
            <>
              <Show
                fallback={
                  <span class={styles.line}>
                    {cooldownLine(result().nextAllowedAt, props.nowMs)}
                  </span>
                }
                when={result().tested}
              >
                <span class={styles.line} data-outcome={result().outcome}>
                  {result().outcome === "ok" ? "Answered" : "Failed"} ·{" "}
                  {formatTimestamp(result().lastCheckedAt)} (
                  {formatRelative(result().lastCheckedAt, props.nowMs)})
                </span>
                <Show when={result().message}>
                  {(message) => <span class={styles.line}>{message()}</span>}
                </Show>
              </Show>
            </>
          )}
        </Show>
      </span>

      <ConfirmDialog
        busy={props.busy}
        confirmLabel="Test now"
        consequences={[
          "Spawns a real claude subprocess against this account's own credential.",
          "Spends one turn of this subscription's usage window.",
          "Answers with a short, safe summary — never the model's full reply.",
        ]}
        onClose={() => setConfirming(false)}
        onConfirm={() => fire(true)}
        open={confirming()}
        subject={props.accountLabel}
        title="Test this Claude subscription now?"
      />
    </div>
  )
}

/**
 * A refused press's note. The result sits in the cache after the cooldown ends, and once it has
 * "next test" is in the past — "On cooldown — next test 9m ago" said the opposite of the truth.
 */
export function cooldownLine(nextAllowedAt: string, nowMs: number): string {
  const at = Date.parse(nextAllowedAt)
  if (Number.isFinite(at) && at > nowMs) {
    return `On cooldown — next test ${formatRelative(nextAllowedAt, nowMs)}`
  }
  return "Cooldown over — ready to test again"
}
