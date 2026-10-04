import { Show } from "solid-js"
import type { ConnectStarted } from "../../lib/api/connect"
import type { ProviderConnectFlow } from "../../lib/api/types"
import styles from "./ConnectDialog.module.scss"

export interface CaptureProps {
  readonly started: ConnectStarted
  readonly connectFlow: ProviderConnectFlow | null
}

/**
 * What follows the paste box: why paste is the mode. Every start this router makes is a paste
 * start — the `claude` CLI owns its redirect, and an OAuth flow whose client registers only its own
 * loopback cannot land on the router (a provider that declares a device-code sign-in never reaches
 * this block; `AccountConnect` shows only that).
 */
export function CaptureNotes(props: CaptureProps) {
  // Stated as the mechanism this flow has, never as a degraded fallback.
  const pasteReason = () =>
    props.connectFlow === "claude-cli"
      ? "The CLI owns its own redirect, so there is no router callback to intercept."
      : "This provider's sign-in only returns to the address its own client registers, which the router cannot receive."

  return (
    <Show when={props.started.capture === "paste"}>
      <p class={styles.note}>
        Paste is the capture mode for this login. {pasteReason()} It is the mode every check on this
        flow is written against.
      </p>
    </Show>
  )
}
