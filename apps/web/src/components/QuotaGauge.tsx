import { mergeProps, Show } from "solid-js"
import { cx } from "../lib/cx"
import styles from "./QuotaGauge.module.scss"

export type QuotaGaugeTone = "neutral" | "warn" | "danger"

export interface QuotaGaugeProps {
  /** `0..1`, or null when the source reported nothing. Null is a reading, not a zero. */
  readonly value: number | null
  /** The formatted figure — `"62%"` or `"—"`. Always rendered beside the bar. */
  readonly text: string
  /** Names the gauge for assistive tech: "Five-hour window utilization". */
  readonly label: string
  /**
   * Why the gauge reads what it reads. On hover for everyone, and **read aloud whenever there is
   * no reading** — a `title` alone is not keyboard-reachable and never appears on touch, so the
   * one case where the note is the entire explanation cannot depend on it.
   */
  readonly note?: string
  readonly tone?: QuotaGaugeTone
  /**
   * Whose figure this is — `reported` by the provider, `measured` by the router, `unlabelled` when
   * a newer router names a source this build does not know. Printed beside the figure so a
   * provider's percentage and the router's own estimate never look like the same kind of number.
   */
  readonly qualifier?: string | null
}

const TONE: Readonly<Record<QuotaGaugeTone, string | undefined>> = {
  neutral: styles.neutral,
  warn: styles.warn,
  danger: styles.danger,
}

/**
 * How much of one quota window is spent.
 *
 * **The figure is always printed next to the bar, and the figure is what assistive tech reads.**
 * A bar alone encodes the value in length and colour, and both fail — colour for anyone who cannot
 * separate the tones, length for anyone comparing two rows a few pixels apart. So the bar is
 * `aria-hidden` decoration over a value that is already text, rather than a `role="meter"`
 * duplicate that makes a screen reader announce the same percentage twice.
 *
 * **A null reading renders as an explicitly unread track, never as zero**, and says "no reading"
 * rather than "—" when read aloud. A threshold-triggered source reports nothing for most of a
 * window by design; drawing that as an empty-because-zero bar says the account is wide open, which
 * is the one misreading that routes traffic at an upstream that has already cut it off.
 */
export function QuotaGauge(props: QuotaGaugeProps) {
  const merged = mergeProps({ tone: "neutral" as QuotaGaugeTone }, props)

  const percent = () => {
    const value = merged.value
    if (value === null || !Number.isFinite(value)) return 0
    return Math.min(100, Math.max(0, value * 100))
  }

  /** Spoken instead of the figure. An em-dash is announced inconsistently and reads as a fault. */
  const spoken = () =>
    merged.value === null
      ? `no reading. ${merged.note ?? "The provider reported nothing for this window."}`
      : `${merged.text}${merged.qualifier ? `, ${merged.qualifier}` : ""}`

  return (
    <div class={styles.root} title={merged.note}>
      <div
        aria-hidden="true"
        class={cx(styles.track, merged.value === null ? styles.unread : undefined)}
      >
        <Show when={merged.value !== null}>
          <div class={cx(styles.fill, TONE[merged.tone])} style={{ width: `${percent()}%` }} />
        </Show>
      </div>

      <span class={styles.figure}>
        <span class={styles.reading}>
          {merged.label}: {spoken()}
        </span>
        <span aria-hidden="true">{merged.text}</span>
      </span>
      <Show when={merged.qualifier}>
        {(qualifier) => <span class={styles.qualifier}>{qualifier()}</span>}
      </Show>
    </div>
  )
}
