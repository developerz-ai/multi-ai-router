import { type JSX, mergeProps, Show } from "solid-js"
import { cx } from "../lib/cx"
import styles from "./Banner.module.scss"

export type BannerTone = "danger" | "warn" | "info"

export interface BannerProps {
  readonly tone?: BannerTone
  readonly title: string
  readonly children?: JSX.Element
  /** A single action — "Re-check all", "Retry". Never more than one. */
  readonly action?: JSX.Element
}

const TONE: Readonly<Record<BannerTone, string | undefined>> = {
  danger: styles.danger,
  warn: styles.warn,
  info: styles.info,
}

/**
 * A standing statement about the fleet, not a toast: it does not dismiss and it
 * does not time out. `exhausted` accounts get one of these on the dashboard,
 * because an account that needs a human with a credit card must not be a status
 * pill three screens deep.
 *
 * `role="status"` rather than `alert`: it is present on load rather than raised
 * by an action, and `alert` interrupts a screen-reader user mid-sentence.
 */
export function Banner(props: BannerProps) {
  const merged = mergeProps({ tone: "info" as BannerTone }, props)

  return (
    <section class={cx(styles.banner, TONE[merged.tone])} role="status">
      <div class={styles.body}>
        <p class={styles.title}>{merged.title}</p>
        <Show when={merged.children !== undefined}>
          <div class={styles.detail}>{merged.children}</div>
        </Show>
      </div>
      <Show when={merged.action !== undefined}>
        <div class={styles.action}>{merged.action}</div>
      </Show>
    </section>
  )
}
