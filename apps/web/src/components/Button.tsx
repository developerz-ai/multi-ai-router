import { type JSX, mergeProps, Show, splitProps } from "solid-js"
import { cx } from "../lib/cx"
import styles from "./Button.module.scss"

export type ButtonTone = "primary" | "neutral" | "ghost" | "danger"
export type ButtonSize = "md" | "sm"

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly tone?: ButtonTone
  readonly size?: ButtonSize
  /**
   * Shows a spinner and swallows presses. The label stays, so the width does not jump, and the
   * button is never `disabled`: one that disables itself when pressed drops focus to `<body>`.
   */
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
  const [local, rest] = splitProps(merged, ["tone", "size", "busy", "class", "children", "onClick"])

  const press: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (event) => {
    // A submit button's default action is the second submit.
    if (local.busy === true) event.preventDefault()
    else if (typeof local.onClick === "function") local.onClick(event)
    else local.onClick?.[0](local.onClick[1], event)
  }

  return (
    <button
      type="button"
      {...rest}
      aria-busy={local.busy === true ? "true" : undefined}
      aria-disabled={local.busy === true ? "true" : undefined}
      class={cx(styles.button, TONE[local.tone], SIZE[local.size], local.class)}
      onClick={press}
    >
      <Show when={local.busy === true}>
        <span aria-hidden="true" class={styles.spinner} />
      </Show>
      {local.children}
    </button>
  )
}
