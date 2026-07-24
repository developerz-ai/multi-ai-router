import { type JSX, mergeProps, Show, splitProps } from "solid-js"
import { cx } from "../lib/cx"
import styles from "./Button.module.scss"

export type ButtonTone = "primary" | "neutral" | "ghost" | "danger"
export type ButtonSize = "md" | "sm"

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly tone?: ButtonTone
  readonly size?: ButtonSize
  /** Disables and shows a spinner. The label stays, so the width does not jump. */
  readonly busy?: boolean
}

const TONE: Readonly<Record<ButtonTone, string | undefined>> = {
  primary: styles.primary,
  neutral: styles.neutral,
  ghost: styles.ghost,
  danger: styles.danger,
}

const SIZE: Readonly<Record<ButtonSize, string | undefined>> = {
  md: styles.md,
  sm: styles.sm,
}

/**
 * The only button in the console. `type="button"` by default, because a bare
 * `<button>` inside a form submits it — which is how a "Cancel" ends up creating
 * an account.
 */
export function Button(props: ButtonProps) {
  const merged = mergeProps({ tone: "neutral" as ButtonTone, size: "md" as ButtonSize }, props)
  const [local, rest] = splitProps(merged, ["tone", "size", "busy", "class", "children"])

  return (
    <button
      type="button"
      {...rest}
      aria-busy={local.busy === true ? "true" : undefined}
      class={cx(styles.button, TONE[local.tone], SIZE[local.size], local.class)}
      disabled={rest.disabled === true || local.busy === true}
    >
      <Show when={local.busy === true}>
        <span aria-hidden="true" class={styles.spinner} />
      </Show>
      {local.children}
    </button>
  )
}
