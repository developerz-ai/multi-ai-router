import { createSignal, onCleanup, Show } from "solid-js"
import { copyText } from "../lib/clipboard"
import { cx } from "../lib/cx"
import { Button } from "./Button"
import styles from "./CopyValue.module.scss"

export interface CopyValueProps {
  readonly value: string
  /** Names the value for assistive tech — "Router key value". */
  readonly label: string
  /**
   * The value is a block — a config file, a shell snippet — so its line breaks
   * are part of it. Without this the default `white-space` collapses a six-line
   * `config.toml` into one unusable line.
   */
  readonly multiline?: boolean
}

/**
 * A value the operator is meant to take away: a router key, an account id.
 *
 * Shown in full and selectable. There is **no masking and no "you will not see
 * this again"** anywhere in this console — router keys are stored encrypted, not
 * hashed, and re-reading one is a supported, audited action. A blurred field
 * with a reveal toggle would imply a shown-once flow that does not exist.
 */
export function CopyValue(props: CopyValueProps) {
  const [state, setState] = createSignal<"idle" | "copied" | "failed">("idle")

  // One timer, held by handle. Cleared before each re-arm — two quick copies must not let the
  // first press's timer wipe the second's confirmation early — and on dispose, so a closed
  // dialog leaves no callback writing to a disposed signal.
  let resetTimer: number | undefined
  onCleanup(() => window.clearTimeout(resetTimer))

  const copy = async () => {
    setState((await copyText(props.value)) ? "copied" : "failed")
    window.clearTimeout(resetTimer)
    resetTimer = window.setTimeout(() => setState("idle"), 2500)
  }

  return (
    <div class={cx(styles.root, props.multiline === true && styles.rootBlock)}>
      <output
        aria-label={props.label}
        class={cx(styles.value, props.multiline === true && styles.block)}
      >
        {props.value}
      </output>
      <div class={styles.actions}>
        <Button onClick={() => void copy()} size="sm" tone="neutral">
          Copy
        </Button>
      </div>
      {/* Polite, not assertive: a copy confirmation must not interrupt. */}
      <p aria-live="polite" class={styles.status}>
        <Show when={state() === "copied"}>Copied to clipboard.</Show>
        <Show when={state() === "failed"}>
          Could not copy — the clipboard is unavailable here. Select the value and copy it manually.
        </Show>
      </p>
    </div>
  )
}
