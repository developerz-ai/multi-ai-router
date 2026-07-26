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
 *
 * **A provider with a connect flow takes no credential here at all.** The row is
 * created first precisely so the one-shot `state` has something to bind to, and
 * the authorization happens afterwards in the Connect dialog — for `oauth` by a
 * code exchange the router performs, for `claude-cli` by driving the `claude`
 * binary into this account's own `CLAUDE_CONFIG_DIR`. Offering a paste box for
 * either would invite an operator to hand-extract a token, which is the thing
 * CLAUDE.md's first non-negotiable exists to prevent.
 *
 * **A provider whose `authKind` is `none` takes one and does not need it.** A
 * local endpoint authenticates nobody, so the field stays — the same endpoint
 * behind a reverse proxy takes a key — and says it may be left empty. Read off
 * the descriptor like everything else here, never off an id.
 */
export function AccountFormDialog(props: AccountFormDialogProps) {
  const [label, setLabel] = createSignal("")
  const [providerId, setProviderId] = createSignal("")
  const [credential, setCredential] = createSignal("")
  const [baseUrl, setBaseUrl] = createSignal("")
  const [dialect, setDialect] = createSignal("")
  const [supportedModels, setSupportedModels] = createSignal("")

  const selected = createMemo(() => findProvider(props.providers, providerId()))
  /** An upstream that authenticates nobody: the key is an option, not a requirement. */
  const credentialOptional = createMemo(() => selected()?.authKind === "none")

  const providerOptions = createMemo<readonly SelectOption[]>(() => [
    { value: "", label: "Choose a provider…" },
    ...props.providers.map((provider) => ({
      value: provider.id,
      label: providerOptionLabel(provider),
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

    const models = parseModelList(supportedModels())

    props.onSubmit({
      label: label().trim(),
      provider: provider.id as ProviderId,
      ...(credential().length > 0 ? { credential: credential() } : {}),
      ...(baseUrl().length > 0 ? { baseUrl: baseUrl() } : {}),
      ...(dialect().length > 0 ? { dialect: dialect() as Dialect } : {}),
      ...(models.length > 0 ? { supportedModels: models } : {}),
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

        <Show when={selected()?.connectFlow === "oauth"}>
          <div class={styles.providerNote}>
            <p>
              This provider is logged in, not pasted. Add the account first — it exists so the
              authorization can bind to it — then choose <strong>Connect</strong> on its row. The
              router performs the code exchange itself and stores only the resulting credential,
              encrypted.
            </p>
          </div>
        </Show>

        <Show when={credentialOptional()}>
          <div class={styles.providerNote}>
            <p>
              A local endpoint: it authenticates nobody, so the credential below is optional. Give
              it an address this router can reach — inside a container <code>localhost</code> is the
              router itself, not the machine you are sitting at.
            </p>
          </div>
        </Show>

        <Show when={selected() !== undefined && selected()?.connectFlow === null}>
          <TextField
            autocomplete="off"
            hint={
              credentialOptional()
                ? "Optional — this endpoint authenticates nobody. Fill it in only if you put something in front of it that does. Encrypted at rest and never returned by any endpoint, in any form."
                : "Encrypted at rest and never returned by any endpoint, in any form."
            }
            label={credentialOptional() ? "Credential (optional)" : "Credential"}
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

        <TextField
          hint="Optional, and comma-separated. Leave empty and this account accepts any model a client names — but it then contributes nothing to GET /v1/models, so a tool filling its picker from the router sees an empty list. Discover fills this in from the provider's own listing once the account exists."
          label="Models it serves"
          onInput={(event) => setSupportedModels(event.currentTarget.value)}
          placeholder="glm-4.6, glm-4.7"
          value={supportedModels()}
        />

        <Show when={props.error !== undefined && props.error !== null}>
          <p class={styles.error} role="alert">
            {errorMessage(props.error)}
          </p>
        </Show>
      </form>
    </Modal>
  )
}

/**
 * Which providers take a login is read off the descriptor, never listed here — a provider that
 * grows an OAuth flow becomes connectable the day its driver file lands, with nothing to change
 * in this file (CLAUDE.md non-negotiable 12).
 */
/**
 * A comma-separated list as the operator typed it. Deduplicated but **not sorted or renamed**:
 * these are the upstream's own ids, and the router's job is to carry a name through unchanged.
 */
export function parseModelList(raw: string): readonly string[] {
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  return [...new Set(names)]
}

function providerOptionLabel(provider: ProviderDescriptor): string {
  if (!provider.creatable) return `${provider.id} — not implemented`
  return provider.connectFlow === null ? provider.id : `${provider.id} — connect after adding`
}
