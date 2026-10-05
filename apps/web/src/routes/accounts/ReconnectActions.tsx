import { Show } from "solid-js"
import { Button } from "../../components/Button"
import type { AccountView } from "../../lib/api/types"
import type { SubscriptionHealth } from "../../lib/subscription-login"

export interface ReconnectActionsProps {
  readonly health: SubscriptionHealth
  /** Starts the guided `ReconnectSequence` over exactly these accounts. */
  readonly onReconnect: (queue: readonly AccountView[]) => void
}

/**
 * The subscription banner's two buttons, both into the one guided `ReconnectSequence`:
 * "Reconnect all" over the logins already gone, "Reconnect expiring" over the ones still working
 * but inside the warn window — so six browser logins are planned on a quiet afternoon rather than
 * discovered on a failing morning. A re-login resets the login's clock; nothing else does.
 */
export function ReconnectActions(props: ReconnectActionsProps) {
  return (
    <>
      <Show when={props.health.needsReconnect.length > 0}>
        <Button onClick={() => props.onReconnect(props.health.needsReconnect)} tone="primary">
          Reconnect all ({props.health.needsReconnect.length})
        </Button>
      </Show>
      <Show when={props.health.expiringSoon.length > 0}>
        <Button onClick={() => props.onReconnect(props.health.expiringSoon)} tone="neutral">
          Reconnect expiring ({props.health.expiringSoon.length})
        </Button>
      </Show>
    </>
  )
}
