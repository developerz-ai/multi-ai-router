import { createEffect, createSignal, on, Show } from "solid-js"
import { Button } from "../../components/Button"
import type { AccountView } from "../../lib/api/types"
import { EgressProxyEditor } from "../egress/EgressProxyEditor"
import styles from "./AccountEditDialog.module.scss"

/**
 * The one proxy this account leaves through. Its own save, because the stored URL is never sent
 * back: a field that opened empty and was saved with the form would clear it.
 *
 * The editor is mounted on request, so opening an account does not ask a proxy vendor for its list.
 */
export function EgressProxyPanel(props: {
  readonly account: AccountView | null
  /** Hidden for a provider that signs in, which the API refuses a proxy for. */
  readonly shown: boolean
}) {
  const [editing, setEditing] = createSignal(false)
  // What the last save answered; the row in `props` is the one the dialog opened on.
  const [saved, setSaved] = createSignal<string | null>(null)

  createEffect(
    on(
      () => props.account?.id,
      () => {
        setEditing(false)
        setSaved(props.account?.egressProxy ?? null)
      },
    ),
  )

  return (
    <Show when={props.shown && props.account}>
      {(account) => (
        <>
          <p class={styles.note}>
            Egress proxy: <code>{saved() ?? "none, direct"}</code>. Every call for this account
            leaves through it. If it fails, the request moves to another account and never goes
            around it.
          </p>
          <Show
            fallback={
              <div>
                <Button onClick={() => setEditing(true)} size="sm" tone="neutral">
                  Change egress proxy
                </Button>
              </div>
            }
            when={editing()}
          >
            <EgressProxyEditor
              accountId={account().id}
              accountLabel={account().label}
              current={saved()}
              onSaved={setSaved}
            />
          </Show>
        </>
      )}
    </Show>
  )
}
