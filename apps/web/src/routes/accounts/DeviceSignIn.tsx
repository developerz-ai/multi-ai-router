import { createEffect, Show } from "solid-js"
import { Button } from "../../components/Button"
import { CopyValue } from "../../components/CopyValue"
import type { ConnectCompleted, DeviceConnectStarted } from "../../lib/api/connect"
import { errorMessage } from "../../lib/api/errors"
import { connectExpiry } from "../../lib/connect-capture"
import { useDeviceConnectStatus } from "../../lib/queries/connect"
import { formatAbsolute } from "../../lib/reset-countdown"
import styles from "./ConnectDialog.module.scss"
import device from "./DeviceSignIn.module.scss"

export interface DeviceSignInProps {
  readonly accountId: string
  /** The attempt on screen, or null before one is asked for. Held by `AccountConnect`. */
  readonly started: DeviceConnectStarted | null
  readonly beginning: boolean
  readonly nowMs: number
  readonly onBegin: () => void
  /** Called once, when the server says the credential landed — never on a guess. */
  readonly onConnected: (completed: ConnectCompleted) => void
}

/**
 * "Sign in with a code" — the device-code sign-in a provider's OAuth flow may declare, for a
 * router on a remote host where the loopback redirect has nowhere to land. The operator opens the
 * issuer's page in any browser, types the code, and this block notices on its own.
 *
 * The status is the server's: each read advances the attempt by at most one upstream poll, at the
 * issuer's interval. "Connected" is only ever the server saying so (`connected`), never inferred.
 * Shown: the user code and the page, which the operator must read. Never shown, because never
 * sent: the issuer's handle for the attempt, or anything it returns on approval.
 */
export function DeviceSignIn(props: DeviceSignInProps) {
  const status = useDeviceConnectStatus(
    () => props.accountId,
    () => props.started,
  )

  createEffect(() => {
    const data = status.data
    if (data?.status === "connected") props.onConnected(data.completed)
  })

  const expiry = () => {
    const started = props.started
    return started === null ? null : connectExpiry(started.expiresAt, props.nowMs)
  }
  /** The server's word wins; a local clock past the deadline only fills in until it arrives. */
  const phase = () => {
    const reported = status.data?.status
    if (reported !== undefined && reported !== "waiting") return reported
    return expiry()?.expired === true ? "expired" : "waiting"
  }
  const deadline = () => {
    const started = props.started
    const left = expiry()
    if (started === null || left === null) return ""
    return `Expires ${formatAbsolute(Date.parse(started.expiresAt))} (${left.remaining} left).`
  }

  return (
    <section class={styles.section}>
      <h3 class={styles.sectionTitle}>Sign in with a code (for remote servers)</h3>
      <Show
        fallback={
          <>
            <p class={styles.hint}>
              No address to copy back: the router asks the provider for a short code, you enter it
              on the provider's page from any browser, and this dialog finishes on its own.
            </p>
            <Button busy={props.beginning} onClick={() => props.onBegin()} tone="neutral">
              Get a code
            </Button>
          </>
        }
        when={props.started}
      >
        {(started) => (
          <>
            <Show when={phase() === "waiting"}>
              <p class={styles.hint}>
                1. Open{" "}
                <a href={started().verificationUrl} rel="noreferrer" target="_blank">
                  {started().verificationUrl}
                </a>{" "}
                and sign in to the account you are attaching. 2. Enter this code:
              </p>
              <span class={device.code}>{started().userCode}</span>
              <CopyValue label="Code" value={started().userCode} />
              <p class={styles.expiry}>{deadline()}</p>
            </Show>
            <p
              class={`${device.status} ${phase() === "denied" ? device.refused : ""} ${phase() === "expired" ? device.ended : ""}`}
              role="status"
            >
              {phase() === "waiting"
                ? "Waiting for you to approve it on the provider's page…"
                : phase() === "denied"
                  ? "The provider refused this sign-in. Get a new code to try again."
                  : phase() === "expired"
                    ? "This code has expired or was replaced. Get a new code to try again."
                    : ""}
            </p>
            <Show when={status.error !== null && status.error !== undefined}>
              <p class={styles.error} role="alert">
                {errorMessage(status.error)}
              </p>
            </Show>
            <Show when={phase() === "denied" || phase() === "expired"}>
              <Button busy={props.beginning} onClick={() => props.onBegin()} tone="neutral">
                Get a new code
              </Button>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}
