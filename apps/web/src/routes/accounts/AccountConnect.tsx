import { createEffect, createMemo, createSignal, on } from "solid-js"
import type { ConnectCompleted, ConnectMode, ConnectStarted } from "../../lib/api/connect"
import type { AccountView, ProviderConnectFlow } from "../../lib/api/types"
import { useWatchedAccount } from "../../lib/queries/accounts"
import { useBeginConnect, useCancelConnect, useCompleteConnect } from "../../lib/queries/connect"
import { connectLabel } from "./account-cells"
import { ConnectDialog, type ConnectProgress } from "./ConnectDialog"

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

/** How often a pending redirect capture re-reads the account. Only ever armed while one is live. */
const REDIRECT_POLL_MS = 3000

/**
 * Owns one login attempt, from start to abandonment.
 *
 * Split from the route because the state it holds is **not** route state: a one-shot authorization
 * that expires on a short TTL, and that must be *actively cancelled* rather than dropped. Closing
 * the dialog on a started-but-unfinished login calls `DELETE /connect`, which terminates the
 * `claude` subprocess and burns the pending `state` now instead of leaving both running until
 * their TTL — closing a tab is not consent to leave a process behind.
 *
 * **The redirect capture finishes somewhere this tab cannot see.** The provider sends the browser
 * to the router's own callback, which completes the exchange server-side; nothing is posted back
 * here. So while a redirect start is outstanding, the account is re-read on an interval and the
 * login is declared complete when the row changes underneath it. The comparison is against
 * `updatedAt` captured at the start rather than against `hasCredential`, because a *reconnect*
 * begins on an account that already holds one — "it has a credential" would report success before
 * the operator had authorized anything.
 *
 * The started login is held in a signal, never in the query cache. It is single-use and a second
 * tab reading it from a cache would be reading a `state` this tab is about to spend.
 */
export function AccountConnect(props: AccountConnectProps) {
  const [started, setStarted] = createSignal<ConnectStarted | null>(null)
  const [completed, setCompleted] = createSignal<ConnectCompleted | null>(null)
  /** The row as it stood when the login began. The thing a redirect is detected against. */
  const [startedAt, setStartedAt] = createSignal<string | null>(null)

  const begin = useBeginConnect()
  const complete = useCompleteConnect()
  const cancel = useCancelConnect()

  const clear = () => {
    setStarted(null)
    setCompleted(null)
    setStartedAt(null)
    begin.reset()
    complete.reset()
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
    setStartedAt(watched.data?.updatedAt ?? account.updatedAt)
    begin.mutate({ id: account.id, mode: mode() }, { onSuccess: (result) => setStarted(result) })
  }

  // Selecting a different account starts a different login. Carrying the previous one across would
  // offer an authorization URL bound to a row the operator is no longer looking at. The dependency
  // is a **memo of the id**, not the prop object: `on` re-runs whenever its source notifies, and a
  // refetch (the poll, or this very login's own invalidation) hands back an equal-but-new
  // `AccountView` — keyed on the object, that wiped a live login and, with `autoBegin`, restarted
  // it in a loop. A memo only notifies when the id itself changes.
  const accountId = createMemo(() => props.account?.id ?? null)
  createEffect(
    on(accountId, (id) => {
      clear()
      if (id !== null && props.autoBegin === true) beginLogin()
    }),
  )

  const awaitingRedirect = () =>
    started()?.capture === "redirect" && completed() === null && props.account !== null

  const watched = useWatchedAccount(
    () => props.account?.id ?? null,
    () => (awaitingRedirect() ? REDIRECT_POLL_MS : false),
  )

  createEffect(() => {
    const pending = started()
    const row = watched.data
    const before = startedAt()
    if (pending === null || completed() !== null || row === undefined || before === null) return
    if (row.updatedAt === before) return

    setCompleted({
      accountId: row.id,
      mode: pending.mode,
      connected: true,
      capture: "redirect",
    })
  })

  /** Abandons an unfinished login (terminating its subprocess), then hands control to `then`. */
  const leave = (then: () => void) => {
    const pending = started()
    const account = props.account
    // Completed logins have nothing left to abandon; an unfinished one does.
    if (pending !== null && completed() === null && account !== null) {
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
      error={begin.error ?? complete.error}
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
