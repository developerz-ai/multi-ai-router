import { createEffect, createMemo, createSignal, on } from "solid-js"
import type {
  ConnectCompleted,
  ConnectMode,
  ConnectStarted,
  DeviceConnectStarted,
} from "../../lib/api/connect"
import { findProvider } from "../../lib/api/providers"
import type { AccountView, ProviderConnectFlow } from "../../lib/api/types"
import {
  useBeginConnect,
  useBeginDeviceConnect,
  useCancelConnect,
  useCompleteConnect,
} from "../../lib/queries/connect"
import { useProviders } from "../../lib/queries/providers"
import { connectLabel } from "./account-cells"
import { ConnectDialog, type ConnectProgress } from "./ConnectDialog"
import { DeviceSignIn } from "./DeviceSignIn"

export interface AccountConnectProps {
  /** Null while no account is selected. The dialog stays shut. */
  readonly account: AccountView | null
  readonly connectFlow: ProviderConnectFlow | null
  readonly nowMs: number
  readonly onClose: () => void
  /**
   * The guided "Reconnect all" run drives this with a step counter and starts each login the moment
   * its account arrives — the operator already asked for all of them, so a second "Start" per row
   * would be six extra clicks. Skip abandons the current login (cancelling its subprocess) and
   * moves on; Next advances after a completed one.
   */
  readonly progress?: ConnectProgress
  readonly autoBegin?: boolean
  readonly onSkip?: () => void
  readonly onNext?: () => void
}

/**
 * Owns one login attempt, from start to abandonment.
 *
 * Split from the route because the state it holds is **not** route state: a one-shot authorization
 * that expires on a short TTL, and that must be *actively cancelled* rather than dropped. Closing
 * the dialog on a started-but-unfinished login calls `DELETE /connect`, which terminates the
 * `claude` subprocess and burns the pending `state` now instead of leaving both running until
 * their TTL — closing a tab is not consent to leave a process behind.
 *
 * **A provider that declares a device-code sign-in connects by it alone** — the dialog offers "Get
 * a code" and nothing else, and its status comes from the server, which alone says "connected".
 *
 * The started login is held in a signal, never in the query cache. It is single-use and a second
 * tab reading it from a cache would be reading a `state` this tab is about to spend.
 */
export function AccountConnect(props: AccountConnectProps) {
  const [started, setStarted] = createSignal<ConnectStarted | null>(null)
  const [completed, setCompleted] = createSignal<ConnectCompleted | null>(null)
  /** A device-code attempt on screen. Exclusive with `started`: each start supersedes the other. */
  const [deviceStarted, setDeviceStarted] = createSignal<DeviceConnectStarted | null>(null)

  const begin = useBeginConnect()
  const complete = useCompleteConnect()
  const cancel = useCancelConnect()
  const beginDevice = useBeginDeviceConnect()
  const providers = useProviders()

  /** Read off the provider's own declaration — the console never names a provider here. */
  const deviceSignIn = () => {
    const account = props.account
    const list = Array.isArray(providers.data) ? providers.data : []
    return (
      props.connectFlow === "oauth" &&
      account !== null &&
      findProvider(list, account.provider)?.deviceSignIn === true
    )
  }

  const clear = () => {
    setStarted(null)
    setCompleted(null)
    setDeviceStarted(null)
    begin.reset()
    complete.reset()
    beginDevice.reset()
  }

  /**
   * Which word the audit trail gets — the same decision the row's button label makes, so the
   * dialog never says "Connect" over a button that said "Reconnect". See `connectLabel`.
   */
  const mode = (): ConnectMode => {
    const account = props.account
    return account !== null && connectLabel(account) === "Reconnect" ? "reconnect" : "connect"
  }

  const beginLogin = () => {
    const account = props.account
    if (account === null) return
    setCompleted(null)
    setDeviceStarted(null)
    begin.mutate({ id: account.id, mode: mode() }, { onSuccess: (result) => setStarted(result) })
  }

  // Selecting a different account starts a different login. Carrying the previous one across would
  // offer an authorization URL bound to a row the operator is no longer looking at. The dependency
  // is a **memo of the id**, not the prop object: `on` re-runs whenever its source notifies, and a
  // refetch (the poll, or this very login's own invalidation) hands back an equal-but-new
  // `AccountView` — keyed on the object, that wiped a live login and, with `autoBegin`, restarted
  // it in a loop. A memo only notifies when the id itself changes.
  const accountId = createMemo(() => props.account?.id ?? null)
  /** A guided run's start, held until it is known which method this provider takes. */
  const [autoPending, setAutoPending] = createSignal(false)
  createEffect(
    on(accountId, (id) => {
      clear()
      setAutoPending(id !== null && props.autoBegin === true)
    }),
  )
  // An OAuth flow's method is the provider's declaration, read from the providers list; a guided
  // run must not start paste-back for a device-only provider just because that list is still in
  // flight — the server would refuse it, and the operator would see an error for nothing.
  createEffect(() => {
    if (!autoPending()) return
    if (props.connectFlow === "oauth" && providers.data === undefined && !providers.isError) return
    setAutoPending(false)
    if (deviceSignIn()) beginDeviceLogin()
    else beginLogin()
  })

  const beginDeviceLogin = () => {
    const account = props.account
    if (account === null) return
    setCompleted(null)
    // The server retires any paste attempt this start supersedes; the screen follows.
    setStarted(null)
    begin.reset()
    beginDevice.mutate(
      { id: account.id, mode: mode() },
      { onSuccess: (result) => setDeviceStarted(result) },
    )
  }

  /** Abandons an unfinished login (terminating its subprocess), then hands control to `then`. */
  const leave = (then: () => void) => {
    const pending = started()
    const account = props.account
    // Completed logins have nothing left to abandon; an unfinished one does.
    if (
      (pending !== null || deviceStarted() !== null) &&
      completed() === null &&
      account !== null
    ) {
      cancel.mutate(account.id)
    }
    clear()
    then()
  }

  return (
    <ConnectDialog
      account={props.account}
      beginning={begin.isPending}
      completed={completed()}
      completing={complete.isPending}
      connectFlow={props.connectFlow}
      deviceOnly={deviceSignIn()}
      devicePanel={
        deviceSignIn() && props.account !== null && completed() === null ? (
          <DeviceSignIn
            accountId={props.account.id}
            beginning={beginDevice.isPending}
            nowMs={props.nowMs}
            onBegin={beginDeviceLogin}
            onConnected={(result) => setCompleted(result)}
            started={deviceStarted()}
          />
        ) : undefined
      }
      error={begin.error ?? complete.error ?? beginDevice.error}
      mode={mode()}
      nowMs={props.nowMs}
      onBegin={beginLogin}
      onClose={() => leave(props.onClose)}
      onComplete={(pasted) => {
        const account = props.account
        if (account === null) return
        complete.mutate({ id: account.id, pasted }, { onSuccess: (result) => setCompleted(result) })
      }}
      onNext={props.onNext === undefined ? undefined : () => leave(props.onNext ?? (() => {}))}
      onSkip={props.onSkip === undefined ? undefined : () => leave(props.onSkip ?? (() => {}))}
      open={props.account !== null}
      progress={props.progress}
      started={started()}
    />
  )
}
