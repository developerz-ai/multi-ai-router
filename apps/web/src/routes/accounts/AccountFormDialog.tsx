import type { Dialect, ProviderId } from "@multi-ai-router/core"
import { createMemo, createSignal, Show } from "solid-js"
import { Button } from "../../components/Button"
import { SelectField, type SelectOption, TextField } from "../../components/Field"
import { Modal } from "../../components/Modal"
import type { CreateAccountInput } from "../../lib/api/accounts"
import { errorMessage } from "../../lib/api/errors"
import { findProvider } from "../../lib/api/providers"
import type { ProviderDescriptor } from "../../lib/api/types"
import styles from "./AccountFormDialog.module.scss"

export interface AccountFormDialogProps {
  readonly open: boolean
  readonly providers: readonly ProviderDescriptor[]
  readonly busy: boolean
  readonly error: unknown
  readonly onSubmit: (input: CreateAccountInput) => void
  readonly onClose: () => void
}

/**
 * Attach an upstream account.
 *
 * The form is **built from `GET /providers`**, never from a list in this file:
 * which providers exist, which need an operator-supplied base URL, which carry
 * a `CLAUDE_CONFIG_DIR` instead of a router-held credential, and which dialects
 * each one serves all come off the descriptor. Adding a provider is one file
 * under `apps/api/src/providers/`; a copy of the list here would make it two.
 *
 * The credential goes up and never comes back. No response in this console has
 * a field that could carry it.
 */
export function AccountFormDialog(props: AccountFormDialogProps) {
  const [label, setLabel] = createSignal("")
  const [providerId, setProviderId] = createSignal("")
  const [credential, setCredential] = createSignal("")
  const [baseUrl, setBaseUrl] = createSignal("")
  const [dialect, setDialect] = createSignal("")

  const selected = createMemo(() => findProvider(props.providers, providerId()))

  const providerOptions = createMemo<readonly SelectOption[]>(() => [
    { value: "", label: "Choose a provider…" },
    ...props.providers.map((provider) => ({
      value: provider.id,
      label: provider.creatable ? provider.id : `${provider.id} — not implemented`,
      disabled: !provider.creatable,
    })),
  ])

  const dialectOptions = createMemo<readonly SelectOption[]>(() => [
    { value: "", label: "Provider default" },
    ...(selected()?.supportedDialects ?? []).map((value) => ({ value, label: value })),
  ])

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const provider = selected()
    if (provider === undefined) return

    props.onSubmit({
      label: label().trim(),
      provider: provider.id as ProviderId,
      ...(credential().length > 0 ? { credential: credential() } : {}),
      ...(baseUrl().length > 0 ? { baseUrl: baseUrl() } : {}),
      ...(dialect().length > 0 ? { dialect: dialect() as Dialect } : {}),
    })
  }

  return (
    <Modal
      description="Many accounts of the same provider is the normal case — five Claude subscriptions side by side is what this is for."
      footer={
        <>
          <Button onClick={() => props.onClose()} tone="ghost">
            Cancel
          </Button>
          <Button busy={props.busy} form="account-form" tone="primary" type="submit">
            Add account
          </Button>
        </>
      }
      onClose={() => props.onClose()}
      open={props.open}
      title="Add account"
    >
      <form class={styles.form} id="account-form" onSubmit={submit}>
        <TextField
          hint="How you will recognise it in a table of five near-identical subscriptions."
          label="Label"
          onInput={(event) => setLabel(event.currentTarget.value)}
          required
          value={label()}
        />

        <SelectField
          label="Provider"
          onChange={(event) => setProviderId(event.currentTarget.value)}
          options={providerOptions()}
          required
          value={providerId()}
        />

        <Show when={selected()}>
          {(provider) => (
            <div class={styles.providerNote}>
              <Show when={provider().reason}>{(reason) => <p>{reason()}</p>}</Show>
              <p>
                Transport: {provider().transport}
                {provider().authKind === null ? "" : ` · auth: ${provider().authKind}`}
              </p>
            </div>
          )}
        </Show>

        <Show when={selected()?.requiresConfigDir === true}>
          <div class={styles.providerNote}>
            <p>
              This account gets a <code>CLAUDE_CONFIG_DIR</code> of its own on the persistent
              volume, named after its id and created with it. Nothing to fill in: the Agent SDK owns
              the credentials inside it and the router never reads them.
            </p>
          </div>
        </Show>

        <Show when={selected() !== undefined && selected()?.requiresConfigDir !== true}>
          <TextField
            autocomplete="off"
            hint="Encrypted at rest and never returned by any endpoint, in any form."
            label="Credential"
            onInput={(event) => setCredential(event.currentTarget.value)}
            type="password"
            value={credential()}
          />
        </Show>

        <Show when={selected()?.requiresBaseUrl === true}>
          <TextField
            hint="This provider has no pinned endpoint — supply the one this account should reach."
            label="Base URL"
            onInput={(event) => setBaseUrl(event.currentTarget.value)}
            required
            type="url"
            value={baseUrl()}
          />
        </Show>

        <Show when={(selected()?.supportedDialects.length ?? 0) > 1}>
          <SelectField
            hint="The wire protocol this account is addressed on. Leave on the default unless you know it serves another."
            label="Dialect"
            onChange={(event) => setDialect(event.currentTarget.value)}
            options={dialectOptions()}
            value={dialect()}
          />
        </Show>

        <Show when={props.error !== undefined && props.error !== null}>
          <p class={styles.error} role="alert">
            {errorMessage(props.error)}
          </p>
        </Show>
      </form>
    </Modal>
  )
}
