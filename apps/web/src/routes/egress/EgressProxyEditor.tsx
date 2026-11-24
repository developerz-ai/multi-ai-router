import { createSignal, Show } from "solid-js"
import { Button } from "../../components/Button"
import { SelectField, TextField } from "../../components/Field"
import type { EgressProxyChoice, EgressProxyInput, ReplaceMode } from "../../lib/api/egress"
import { errorMessage } from "../../lib/api/errors"
import { createNow } from "../../lib/clock"
import { loadedData } from "../../lib/loaded"
import { useEgressOverview, useSetEgressProxy, useTestProxy } from "../../lib/queries/egress"
import styles from "../accounts/AccountEditDialog.module.scss"
import egress from "./egress.module.scss"
import { REPLACE_OPTIONS, REPLACE_RULE, replaceable, TEST_CLOCK_MS } from "./egress-copy"
import { ProxyHealth } from "./ProxyHealth"
import { ProxyTest } from "./ProxyTest"
import { ReplaceModeField } from "./ReplaceModeField"

/** Choose, test and set one account's proxy. A form of its own, so Enter saves the proxy. */
export function EgressProxyEditor(props: {
  readonly accountId: string
  readonly accountLabel: string
  readonly current: string | null
  readonly onSaved: (address: string | null) => void
}) {
  const [url, setUrl] = createSignal("")
  const [choice, setChoice] = createSignal("")
  const [replace, setReplace] = createSignal<ReplaceMode | null>(null)
  const overview = useEgressOverview()
  const save = useSetEgressProxy()
  const test = useTestProxy()
  const now = createNow(TEST_CLOCK_MS)

  const listed = () => loadedData(overview)?.proxies ?? []
  const assignment = () =>
    loadedData(overview)?.assigned.find((row) => row.account.id === props.accountId)
  // A change of proxy is not a change of mind: shown is the mode the account has, and unless the
  // operator picks one here none is sent, so the router keeps what is stored.
  const mode = () => replace() ?? assignment()?.replace ?? "manual"
  const chosen = () => listed().find((proxy) => choiceKey(proxy) === choice())

  /** What the form names. A typed URL wins; null when it names nothing. */
  const draft = (): EgressProxyInput | null => {
    if (url().trim() !== "") return { url: url().trim() }
    const proxy = chosen()
    return proxy === undefined ? null : { vendor: proxy.vendor, id: proxy.id }
  }

  // A test is about the proxy that was named when it ran.
  const rename = (change: () => void) => {
    change()
    test.reset()
  }

  const submit = (proxy: (EgressProxyInput & { replace?: ReplaceMode }) | null) => {
    const sent = { url: url(), choice: choice(), replace: replace() }
    save.mutate(
      { accountId: props.accountId, proxy },
      {
        onSuccess: (row) => {
          // The typed URL holds a password, and a mutation keeps what it was called with.
          save.reset()
          // A draft changed while the save was in flight is the operator's next: only the field
          // that was sent is cleared out of it, and a test result by now is about the new one.
          const changed =
            url() !== sent.url || choice() !== sent.choice || replace() !== sent.replace
          const typed = proxy !== null && "url" in proxy
          if (!changed || (typed && url() === sent.url)) setUrl("")
          if (!changed || (!typed && choice() === sent.choice)) setChoice("")
          if (!changed || (!typed && replace() === sent.replace)) setReplace(null)
          if (!changed) test.reset()
          props.onSaved(row.egressProxy ?? null)
        },
      },
    )
  }

  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault()
    const proxy = draft()
    if (proxy === null || save.isPending) return
    const picked = replace()
    submit("url" in proxy || picked === null ? proxy : { ...proxy, replace: picked })
  }

  return (
    <form class={egress.editor} onSubmit={onSubmit}>
      <Show when={assignment()}>
        {(row) => (
          <div class={egress.row}>
            <ProxyHealth assignment={row()} nowMs={now()} />
            <ReplaceModeField
              accountId={props.accountId}
              accountLabel={props.accountLabel}
              mode={row().replace}
              replaceable={replaceable(row(), new Set(listed().map((proxy) => proxy.address)))}
            />
          </div>
        )}
      </Show>
      <Show when={listed().length > 0}>
        <SelectField
          label="Choose a proxy"
          onChange={(event) => rename(() => setChoice(event.currentTarget.value))}
          options={[
            { value: "", label: "Choose…" },
            ...listed().map((proxy) => ({ value: choiceKey(proxy), label: choiceLabel(proxy) })),
          ]}
          value={choice()}
        />
      </Show>
      <Show when={chosen() !== undefined && url().trim() === ""}>
        <SelectField
          label="If it dies"
          onChange={(event) => setReplace(event.currentTarget.value as ReplaceMode)}
          options={REPLACE_OPTIONS}
          value={mode()}
        />
      </Show>
      <p class={styles.note}>{REPLACE_RULE}</p>
      <TextField
        autocomplete="new-password"
        hint="http(s)://user:password@host:port. Encrypted at rest; only host and port are ever shown. A proxy typed in here is never replaced."
        label="Proxy URL"
        onInput={(event) => rename(() => setUrl(event.currentTarget.value))}
        type="password"
        value={url()}
      />
      <div class={egress.row}>
        <Button busy={save.isPending} disabled={draft() === null} size="sm" type="submit">
          Set proxy
        </Button>
        <ProxyTest
          busy={test.isPending}
          disabled={draft() === null}
          error={test.error}
          label="Test this proxy now"
          nowMs={now()}
          onTest={() => {
            const proxy = draft()
            if (proxy !== null) test.mutate({ ...proxy, accountId: props.accountId })
          }}
          result={test.data}
        />
        <Show when={props.current !== null}>
          <Button busy={save.isPending} onClick={() => submit(null)} size="sm" tone="danger">
            Remove proxy
          </Button>
        </Show>
      </div>
      <Show when={save.error ?? overview.error}>
        {(error) => (
          <p class={styles.error} role="alert">
            {errorMessage(error())}
          </p>
        )}
      </Show>
    </form>
  )
}

const choiceKey = (proxy: EgressProxyChoice) => `${proxy.vendor}/${proxy.id}`

function choiceLabel(proxy: EgressProxyChoice): string {
  const used =
    proxy.accounts.length === 0
      ? ""
      : ` — used by ${proxy.accounts.map((account) => account.label).join(", ")}`
  const place = proxy.location === "" ? "" : ` ${proxy.location}`
  return `${proxy.address}${place}${proxy.valid ? "" : " (not valid)"}${used}`
}
