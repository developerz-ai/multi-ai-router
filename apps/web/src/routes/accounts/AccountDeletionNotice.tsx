import { Show } from "solid-js"
import { Banner } from "../../components/Banner"
import { Button } from "../../components/Button"

/** Survives resetting the delete dialog's mutation state; deferred cleanup does not undo deletion. */
export function AccountDeletionNotice(props: { label: string | null; onDismiss: () => void }) {
  return (
    <Show when={props.label !== null}>
      <Banner
        title="Account deleted; credential cleanup deferred"
        tone="warn"
        action={
          <Button onClick={props.onDismiss} tone="neutral">
            Dismiss
          </Button>
        }
      >
        {props.label} is no longer available for routing. Its credential directory remains until its
        owners are confirmed to have exited. Cleanup may require operator follow-up if an owner’s
        exit cannot be confirmed.
      </Banner>
    </Show>
  )
}
