import { Show } from "solid-js"
import { Badge } from "../../components/Badge"
import type { ConnectCompleted, ConnectMode } from "../../lib/api/connect"
import styles from "./ConnectDialog.module.scss"

export interface ConnectResultProps {
  readonly completed: ConnectCompleted | null
  readonly mode: ConnectMode
}

/**
 * What a finished login says.
 *
 * The live region is rendered **before** it has anything to announce, and that is the whole reason
 * this is a component rather than four lines inside the dialog: a `role="status"` inserted into the
 * DOM together with its own text is announced unreliably, so the region has to pre-date the update
 * it carries. Keeping the empty wrapper mounted is easy to delete by accident when it sits inline
 * looking like dead markup.
 *
 * Nothing here names a code, a `state` or a token — `capture` is the *mode* that delivered the
 * value, never the value.
 */
export function ConnectResult(props: ConnectResultProps) {
  return (
    <section class={styles.success} role="status">
      <Show when={props.completed}>
        {(completed) => (
          <>
            <p class={styles.successLine}>
              {props.mode === "reconnect" ? "Re-authorized." : "Connected."} This account can serve
              requests again, and no credential material is readable from this console.
            </p>

            <Show when={completed().repaired === true}>
              <p class={styles.hint}>
                The credential file on disk needed re-minifying, and was repaired in place.
              </p>
            </Show>

            <Show when={completed().capture}>
              {(capture) => (
                <p class={styles.hint}>
                  Delivered by <Badge tone="accent">{capture()}</Badge> capture.
                </p>
              )}
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}
