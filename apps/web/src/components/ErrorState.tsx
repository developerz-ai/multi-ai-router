import { Show } from "solid-js"
import { errorMessage } from "../lib/api/errors"
import { Button } from "./Button"
import styles from "./ErrorState.module.scss"

export interface ErrorStateProps {
  /** What failed, in the operator's terms — "Accounts could not be loaded". */
  readonly title: string
  /** The thrown value. Rendered through `errorMessage`, never as a status. */
  readonly error: unknown
  readonly onRetry?: () => void
  readonly retrying?: boolean
}

/**
 * A failed read, as a designed state.
 *
 * The server's own sentence is what gets rendered — a 409 from a delete names
 * the keys it would narrow, and that text *is* the useful part of the response.
 * "Error 409" would throw away everything the router took the trouble to say.
 */
export function ErrorState(props: ErrorStateProps) {
  return (
    <section class={styles.root} role="alert">
      <div class={styles.body}>
        <p class={styles.title}>{props.title}</p>
        <p class={styles.message}>{errorMessage(props.error)}</p>
      </div>
      <Show when={props.onRetry !== undefined}>
        <Button busy={props.retrying === true} onClick={() => props.onRetry?.()} tone="neutral">
          Try again
        </Button>
      </Show>
    </section>
  )
}
