import { type JSX, Show } from "solid-js"
import styles from "./PageHeader.module.scss"

export interface PageHeaderProps {
  readonly title: string
  readonly subtitle?: string
  /** Page-level actions — "Add account", "Mint key", window pickers. */
  readonly actions?: JSX.Element
}

export function PageHeader(props: PageHeaderProps) {
  return (
    <header class={styles.root}>
      <div>
        <h1 class={styles.title}>{props.title}</h1>
        <Show when={props.subtitle}>
          {(subtitle) => <p class={styles.subtitle}>{subtitle()}</p>}
        </Show>
      </div>
      <Show when={props.actions !== undefined}>
        <div class={styles.actions}>{props.actions}</div>
      </Show>
    </header>
  )
}
