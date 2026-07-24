import type { AccountStatus } from "@multi-ai-router/core"
import { createMemo, mergeProps } from "solid-js"
import { statusPresentation } from "../lib/account-status"
import { cx } from "../lib/cx"
import styles from "./StatusDot.module.scss"

export interface StatusDotProps {
  readonly status: AccountStatus
  /** Hide the text visually; it stays in the accessibility tree. */
  readonly compact?: boolean
}

/**
 * The status atom used in every table row and detail header. Colour alone never
 * carries the meaning — the label ships with it, visually or to a screen
 * reader, and the two danger statuses differ in shape as well as in words.
 */
export function StatusDot(props: StatusDotProps) {
  // `mergeProps`, not destructuring with a default: destructuring reads the
  // prop once and severs it from the reactive graph for good.
  const merged = mergeProps({ compact: false }, props)
  const presentation = createMemo(() => statusPresentation(merged.status))

  return (
    <span class={styles.root} title={presentation().hint}>
      <span
        aria-hidden="true"
        class={cx(styles.dot, presentation().fill === "hollow" && styles.hollow)}
        style={{ "--dot-color": `var(${presentation().token})` }}
      />
      <span class={merged.compact ? styles.srOnly : styles.label}>{presentation().label}</span>
    </span>
  )
}
