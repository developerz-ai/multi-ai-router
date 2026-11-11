import { createUniqueId, type JSX, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { createFocusTrap } from "../lib/focus-trap"
import { createScrollLock } from "../lib/scroll-lock"
import { Icon } from "./Icon"
import styles from "./Modal.module.scss"

/**
 * How wide the panel is allowed to get. A name rather than a number, so the
 * dialogs stay a set and the widths live in one stylesheet.
 *
 * `sm` a confirmation — one sentence and two buttons.
 * `md` the default, and enough for a single-column form.
 * `lg` a dense form: two columns, a member list, or a table.
 */
export type ModalSize = "sm" | "md" | "lg"

export interface ModalProps {
  readonly open: boolean
  readonly title: string
  /** One line under the title: what this dialog is about to do. */
  readonly description?: string
  readonly onClose: () => void
  readonly children: JSX.Element
  /** Actions, right-aligned. The dialog never places them itself. */
  readonly footer?: JSX.Element
  /** Defaults to `md`. See {@link ModalSize}. */
  readonly size?: ModalSize
  /**
   * False while the dialog's action is in flight: Escape, the scrim and the close button do
   * nothing, so the server's answer — a `409` naming what blocked a delete — has a dialog to land
   * in. Defaults to true.
   */
  readonly dismissible?: boolean
}

/**
 * The console's one dialog. Everything modal goes through it — the account
 * form, the mint form, every destructive confirmation — so focus containment
 * and Escape are implemented once rather than approximated per caller.
 *
 * Rendered through a `Portal` so it escapes the layout grid's stacking and
 * overflow. `AppLayout`'s nav is a sticky sidebar with its own z-index; a
 * dialog nested inside a scrolling `<main>` would clip against it.
 */
export function Modal(props: ModalProps) {
  const titleId = createUniqueId()
  const descriptionId = createUniqueId()
  let panel: HTMLDivElement | undefined
  const dismiss = () => {
    if (props.dismissible !== false) props.onClose()
  }

  createFocusTrap({
    container: () => panel,
    active: () => props.open,
    onEscape: dismiss,
  })
  createScrollLock(() => props.open)

  return (
    <Show when={props.open}>
      <Portal>
        <div class={styles.layer}>
          {/* Dismiss on outside tap; keyboard users get Escape from the trap. */}
          <div aria-hidden="true" class={styles.scrim} onClick={dismiss} />
          <div
            aria-describedby={props.description === undefined ? undefined : descriptionId}
            aria-labelledby={titleId}
            aria-modal="true"
            class={`${styles.panel} ${styles[props.size ?? "md"]}`}
            ref={panel}
            role="dialog"
          >
            <header class={styles.header}>
              <div class={styles.heading}>
                <h2 class={styles.title} id={titleId}>
                  {props.title}
                </h2>
                <Show when={props.description}>
                  {(description) => (
                    <p class={styles.description} id={descriptionId}>
                      {description()}
                    </p>
                  )}
                </Show>
              </div>
              <button
                aria-label="Close"
                class={styles.close}
                disabled={props.dismissible === false}
                onClick={dismiss}
                type="button"
              >
                <Icon name="close" />
              </button>
            </header>

            <div class={styles.body}>{props.children}</div>

            <Show when={props.footer !== undefined}>
              <footer class={styles.footer}>{props.footer}</footer>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
