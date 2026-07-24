import { For } from "solid-js"
import styles from "./Placeholder.module.scss"

export interface PlaceholderProps {
  /** What this surface will do, in one sentence. */
  readonly summary: string
  /** The concrete pieces still to be built here. */
  readonly items: readonly string[]
}

/**
 * Marks a screen as scaffold. Every route below ships one until its real
 * surface lands, so nothing in the console ever looks implemented when it is
 * not.
 */
export function Placeholder(props: PlaceholderProps) {
  return (
    <section class={styles.root} aria-label="Not implemented yet">
      <span class={styles.badge}>Not implemented</span>
      <p class={styles.summary}>{props.summary}</p>
      <ul class={styles.items}>
        <For each={props.items}>{(item) => <li class={styles.item}>{item}</li>}</For>
      </ul>
    </section>
  )
}
