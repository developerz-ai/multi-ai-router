import { Show } from "solid-js"
import { CopyValue } from "../../components/CopyValue"
import type { ConnectStarted } from "../../lib/api/connect"
import type { ProviderConnectFlow } from "../../lib/api/types"
import styles from "./ConnectDialog.module.scss"

export interface CaptureProps {
  readonly started: ConnectStarted
  readonly connectFlow: ProviderConnectFlow | null
}

/**
 * Where the value to paste will be, said before the paste box rather than after it.
 *
 * A first-party client's redirect is a loopback on the operator's own machine — for ChatGPT,
 * `http://localhost:1455/auth/callback` — where nothing is listening. The browser's "can't reach
 * this page" is the expected end of a *successful* authorization, and an operator who has not been
 * told that reads it as failure and starts over, spending the login. So the instruction names the
 * address, says the error page is expected, and says exactly what to copy. Never the value itself.
 */
export function PasteGuide(props: CaptureProps) {
  const loopback = () => {
    const uri = props.started.redirectUri
    return props.started.capture === "paste" && uri !== undefined && isLoopback(uri) ? uri : null
  }
  return (
    <Show when={loopback()}>
      {(uri) => (
        <ol class={styles.hint}>
          <li>Open the authorization URL above and approve the sign-in.</li>
          <li>
            The browser then goes to <code>{uri()}?code=…&amp;state=…</code> and shows a "can't
            connect" error. That is expected — nothing listens there, and the address is the result.
          </li>
          <li>
            Copy the <strong>whole address</strong> from the browser's address bar and paste it
            below, unedited, before the login expires.
          </li>
        </ol>
      )}
    </Show>
  )
}

/** What follows the paste box: why paste is the mode, or the redirect shortcut where one exists. */
export function CaptureNotes(props: CaptureProps) {
  // Stated as the mechanism this flow has, never as a degraded fallback.
  const pasteReason = () =>
    props.connectFlow === "claude-cli"
      ? "The CLI owns its own redirect, so there is no router callback to intercept."
      : "This provider's sign-in only returns to the address its own client registers, which the router cannot receive."

  return (
    <>
      <Show when={props.started.capture === "paste"}>
        <p class={styles.note}>
          Paste is the capture mode for this login. {pasteReason()} It is the mode every check on
          this flow is written against.
        </p>
      </Show>

      <Show when={props.started.capture === "redirect" ? props.started.redirectUri : undefined}>
        {(redirectUri) => (
          <section class={styles.section}>
            <h3 class={styles.sectionTitle}>Or let the browser come back</h3>
            <p class={styles.hint}>
              The provider lands the browser back on the router at this address and the exchange
              happens there, not in this tab. This dialog notices once the account holds the new
              credential; if the callback page says it worked and this dialog has not caught up,
              close it — the account row is the record.
            </p>
            <CopyValue label="Redirect URI" value={redirectUri()} />
            <p class={styles.hint}>
              The box above stays live either way: a callback the browser cannot load still leaves
              the value in the address bar.
            </p>
          </section>
        )}
      </Show>
    </>
  )
}

function isLoopback(uri: string): boolean {
  try {
    const host = new URL(uri).hostname
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]"
  } catch {
    return false
  }
}
