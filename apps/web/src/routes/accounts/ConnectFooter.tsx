import { Show } from "solid-js"
import { Button } from "../../components/Button"
import type { ConnectProgress } from "./ConnectDialog"

export interface ConnectFooterProps {
  /** False for a provider that takes a key: only "Close" is offered. */
  readonly connectable: boolean
  readonly completed: boolean
  /** A started, unexpired login is on screen — the paste form is what submits. */
  readonly live: boolean
  readonly beginning: boolean
  readonly completing: boolean
  readonly submittable: boolean
  readonly startLabel: string
  readonly formId: string
  readonly progress: ConnectProgress | undefined
  readonly lastStep: boolean
  readonly onBegin: () => void
  readonly onClose: () => void
  readonly onSkip: (() => void) | undefined
  readonly onNext: (() => void) | undefined
}

/**
 * The connect dialog's buttons, in the order an operator reads them: the way out, the way past,
 * the way forward. Split from the dialog because the guided "Reconnect all" run doubles the set —
 * Stop instead of Cancel, Skip while a step is pending, Next (or Finish) once it has landed — and
 * the dialog body is about the login, not about which of six buttons applies.
 */
export function ConnectFooter(props: ConnectFooterProps) {
  const guided = () => props.progress !== undefined
  const closeLabel = () => {
    if (props.completed || !props.connectable) return "Close"
    return guided() ? "Stop" : "Cancel"
  }

  return (
    <>
      <Button onClick={() => props.onClose()} tone="ghost">
        {closeLabel()}
      </Button>
      {/* A step the operator cannot finish now — wrong browser, no phone — must not block the
          five behind it. Skipping abandons this login only. */}
      <Show when={guided() && !props.completed && props.onSkip}>
        {(skip) => (
          <Button onClick={() => skip()()} tone="neutral">
            Skip this account
          </Button>
        )}
      </Show>
      <Show when={guided() && props.completed && props.onNext}>
        {(next) => (
          <Button onClick={() => next()()} tone="primary">
            {props.lastStep ? "Finish" : "Next account"}
          </Button>
        )}
      </Show>
      <Show when={props.connectable && !props.completed}>
        <Show
          fallback={
            <Button busy={props.beginning} onClick={() => props.onBegin()} tone="primary">
              {props.startLabel}
            </Button>
          }
          when={props.live}
        >
          <Button
            busy={props.completing}
            disabled={!props.submittable}
            form={props.formId}
            tone="primary"
            type="submit"
          >
            Complete login
          </Button>
        </Show>
      </Show>
    </>
  )
}
