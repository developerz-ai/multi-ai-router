import { type JSX, mergeProps } from "solid-js"
import { cx } from "../lib/cx"
import styles from "./Badge.module.scss"

export type BadgeTone = "neutral" | "accent" | "warn" | "danger" | "ok"

export interface BadgeProps {
  readonly tone?: BadgeTone
  /** Long-form explanation on hover. Never the only place a fact is stated. */
  readonly title?: string
  readonly children: JSX.Element
}

const TONE: Readonly<Record<BadgeTone, string | undefined>> = {
  neutral: styles.neutral,
  accent: styles.accent,
  warn: styles.warn,
  danger: styles.danger,
  ok: styles.ok,
}

/** A small qualifier pill: a scope kind, a policy, a `reported` / `estimated` label. */
export function Badge(props: BadgeProps) {
  const merged = mergeProps({ tone: "neutral" as BadgeTone }, props)

  return (
    <span class={cx(styles.badge, TONE[merged.tone])} title={merged.title}>
      {merged.children}
    </span>
  )
}
