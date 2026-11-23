import { createEffect, createSignal, on, Show } from "solid-js"
import { Button } from "../../components/Button"
import { SelectField, TextField } from "../../components/Field"
import type { EgressProxyInput } from "../../lib/api/egress"
import { errorMessage } from "../../lib/api/errors"
import type { AccountView } from "../../lib/api/types"
import { useEgressProxies, useSetEgressProxy } from "../../lib/queries/egress"
import styles from "./AccountEditDialog.module.scss"

/**
 * The one proxy this account leaves through. Its own save, because the stored URL is never sent
 * back: a field that opened empty and was saved with the form would clear it.
 *
 * The editor is mounted on request, so opening an account does not ask Webshare for its list.
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
            <EgressProxyEditor accountId={account().id} current={saved()} onSaved={setSaved} />
          </Show>
        </>
      )}
    </Show>
  )
}

function EgressProxyEditor(props: {
  readonly accountId: string
  readonly current: string | null
  readonly onSaved: (address: string | null) => void
}) {
  const [url, setUrl] = createSignal("")
  const [choice, setChoice] = createSignal("")
  const proxies = useEgressProxies()
  const save = useSetEgressProxy()

  const submit = (proxy: EgressProxyInput | null) =>
    save.mutate(
      { accountId: props.accountId, proxy },
      {
        onSuccess: (row) => {
          setUrl("")
          setChoice("")
          props.onSaved(row.egressProxy ?? null)
        },
      },
    )

  const listed = () => (proxies.isSuccess ? (proxies.data?.proxies ?? []) : [])

  return (
    <>
      <Show when={listed().length > 0}>
        <SelectField
          label="Choose a proxy"
          onChange={(event) => setChoice(event.currentTarget.value)}
          options={[
            { value: "", label: "Choose…" },
            ...listed().map((proxy) => ({
              value: proxy.id,
              label: `${proxy.address} ${proxy.location}${proxy.valid ? "" : " (not valid)"}`,
            })),
          ]}
          value={choice()}
        />
      </Show>
      <TextField
        autocomplete="off"
        hint="http(s)://user:password@host:port. Encrypted at rest; only host and port are ever shown."
        label="Proxy URL"
        onInput={(event) => setUrl(event.currentTarget.value)}
        type="password"
        value={url()}
      />
      <div>
        <Button
          busy={save.isPending}
          disabled={url().trim() === "" && choice() === ""}
          onClick={() =>
            submit(
              url().trim() === "" ? { vendor: "webshare", id: choice() } : { url: url().trim() },
            )
          }
          size="sm"
          tone="neutral"
        >
          Set proxy
        </Button>{" "}
        <Show when={props.current !== null}>
          <Button busy={save.isPending} onClick={() => submit(null)} size="sm" tone="danger">
            Remove proxy
          </Button>
        </Show>
      </div>
      <Show when={save.error ?? proxies.error}>
        {(error) => (
          <p class={styles.error} role="alert">
            {errorMessage(error())}
          </p>
        )}
      </Show>
    </>
  )
}
