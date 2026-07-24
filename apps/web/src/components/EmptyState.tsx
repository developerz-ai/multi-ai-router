import { type JSX, Show } from "solid-js"
import styles from "./EmptyState.module.scss"
import { Icon, type IconName } from "./Icon"

export interface EmptyStateProps {
  readonly icon: IconName
  readonly title: string
  /** What this surface will hold, and why it is worth filling. One sentence. */
  readonly description: string
  /** The action that ends the empty state — "Add account", "Mint key". */
  readonly action?: JSX.Element
}

/**
 * A surface with nothing in it yet. Designed rather than a line of grey text:
 * an empty accounts table is the *first* thing a new operator sees, and it is
 * the only chance the console gets to say what belongs there.
 *
 * Distinct from `Placeholder`, which marks a screen as unbuilt. This one means
 * the screen works and the fleet is empty.
 */
export function EmptyState(props: EmptyStateProps) {
  return (
    <section class={styles.root}>
      <span aria-hidden="true" class={styles.glyph}>
        <Icon name={props.icon} />
      </span>
      <h2 class={styles.title}>{props.title}</h2>
      <p class={styles.description}>{props.description}</p>
      <Show when={props.action !== undefined}>
        <div class={styles.action}>{props.action}</div>
      </Show>
    </section>
  )
}
