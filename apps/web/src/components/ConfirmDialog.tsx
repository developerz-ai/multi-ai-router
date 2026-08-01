import { For, Show } from "solid-js"
import { errorMessage, isConflict } from "../lib/api/errors"
import { Button } from "./Button"
import styles from "./ConfirmDialog.module.scss"
import { Modal } from "./Modal"

export interface ConfirmDialogProps {
  readonly open: boolean
  readonly title: string
  /** The subject, verbatim — the account label, the key name. */
  readonly subject: string
  /**
   * **Exactly what breaks.** Not "this cannot be undone" — the concrete
   * consequences, one per line: which clients stop working, what history is
   * kept, what the non-destructive alternative is.
   */
  readonly consequences: readonly string[]
  readonly confirmLabel: string
  readonly busy?: boolean
  /** The rejection, if the server refused. Rendered verbatim. */
  readonly error?: unknown
  readonly onConfirm: () => void
  readonly onClose: () => void
}

/**
 * The one confirmation in the console.
 *
 * Two rules it exists to hold. First, a destructive action states its
 * consequences in the operator's terms before it runs. Second — and this is the
 * one that is easy to get wrong — when the server **refuses**, its sentence is
 * shown here rather than swallowed. A delete blocked by a key's scope comes back
 * as a 409 naming every key it would narrow; that list is the whole answer to
 * "why can't I delete this", and it is worth more than the dialog's own copy.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <Modal
      size="sm"
      description={`This affects "${props.subject}".`}
      footer={
        <>
          <Button onClick={() => props.onClose()} tone="ghost">
            Cancel
          </Button>
          <Button busy={props.busy === true} onClick={() => props.onConfirm()} tone="danger">
            {props.confirmLabel}
          </Button>
        </>
      }
      onClose={() => props.onClose()}
      open={props.open}
      title={props.title}
    >
      <ul class={styles.consequences}>
        <For each={props.consequences}>
          {(consequence) => (
            <li class={styles.consequence}>
              <span aria-hidden="true" class={styles.marker} />
              <span>{consequence}</span>
            </li>
          )}
        </For>
      </ul>

      <Show when={props.error !== undefined && props.error !== null}>
        <div class={styles.rejection} role="alert">
          <p class={styles.rejectionTitle}>
            {isConflict(props.error) ? "The router refused" : "That did not work"}
          </p>
          <p class={styles.rejectionMessage}>{errorMessage(props.error)}</p>
        </div>
      </Show>
    </Modal>
  )
}
