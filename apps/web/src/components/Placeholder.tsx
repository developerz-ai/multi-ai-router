import { For } from "solid-js"
import { Icon, type IconName } from "./Icon"
import styles from "./Placeholder.module.scss"

export interface PlaceholderProps {
  /** What this surface will do, in one sentence. */
  readonly summary: string
  /** The concrete pieces still to be built here. */
  readonly items: readonly string[]
  /** Echoes the section's nav icon so the block reads as part of the screen. */
  readonly icon: IconName
}

/**
 * Marks a screen as scaffold. Every route ships one until its real surface
 * lands, so nothing in the console ever looks implemented when it is not.
 *
 * Designed rather than blank: an operator will look at these for weeks, and a
 * bare "coming soon" tells them nothing about what to expect.
 */
export function Placeholder(props: PlaceholderProps) {
  return (
    <section aria-label="Not implemented yet" class={styles.root}>
      <div class={styles.header}>
        <span class={styles.glyph}>
          <Icon name={props.icon} />
        </span>
        <span class={styles.badge}>Not implemented</span>
        <p class={styles.summary}>{props.summary}</p>
      </div>

      <ul class={styles.items}>
        <For each={props.items}>
          {(item) => (
            <li class={styles.item}>
              <span aria-hidden="true" class={styles.marker} />
              <span>{item}</span>
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}
