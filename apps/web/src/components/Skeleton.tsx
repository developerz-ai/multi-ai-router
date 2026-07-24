import { mergeProps } from "solid-js"
import styles from "./Skeleton.module.scss"

export interface SkeletonProps {
  /** CSS length. Defaults to filling the container. */
  readonly width?: string
  readonly height?: string
  /** Round it fully — for avatar and status-dot placeholders. */
  readonly circle?: boolean
}

/**
 * A loading placeholder shaped like the content it stands in for. Marked
 * `aria-hidden`; the *container* owns `aria-busy` and the status message, so a
 * screen reader hears "loading" once instead of once per grey box.
 */
export function Skeleton(props: SkeletonProps) {
  const merged = mergeProps({ width: "100%", height: "1rem", circle: false }, props)

  return (
    <span
      aria-hidden="true"
      class={merged.circle ? styles.circle : styles.block}
      style={{ width: merged.width, height: merged.height }}
    />
  )
}
