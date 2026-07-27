import type { AccountBilling, Dialect } from "@multi-ai-router/core"
import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { Button } from "../../components/Button"
import { Field, SelectField, type SelectOption, TextField } from "../../components/Field"
import { Modal } from "../../components/Modal"
import {
  formatModelAliases,
  formatModelList,
  parseModelAliases,
  parseModelList,
} from "../../lib/account-models"
import type { UpdateAccountInput } from "../../lib/api/accounts"
import { errorMessage } from "../../lib/api/errors"
import type { AccountView, ProviderDescriptor } from "../../lib/api/types"
import { BILLING_OPTIONS, billingConsequence } from "../../lib/billing"
import styles from "./AccountEditDialog.module.scss"

export interface AccountEditDialogProps {
  readonly open: boolean
  /** The account being edited. `null` closes the dialog — this form never creates. */
  readonly account: AccountView | null
  /** How `GET /providers` describes this account's provider. Every rule below is read off it. */
  readonly provider: ProviderDescriptor | undefined
  readonly busy: boolean
  readonly error: unknown
  readonly onSubmit: (patch: UpdateAccountInput) => void
  readonly onClose: () => void
}

/**
 * Edit an upstream account in place.
 *
 * Separate from the add form on purpose: creating picks a provider and explains
 * which login it takes, editing rotates a credential and tunes routing. The two
 * share a provider descriptor and nothing else, and folding them together would
 * mean one dialog whose every field is conditional on which half it is being.
 *
 * **The provider is not editable, and neither is the config directory.** An
 * account's provider decides its driver, its credential rule and its dialect
 * set; changing it in place would be a different account wearing the same id and
 * the same usage history. Delete and re-add is the honest spelling.
 *
 * **The credential box rotates, it never reveals.** No endpoint in this system
 * returns stored credential material, so the box opens empty and an empty box
 * means "leave the stored one alone". It is absent entirely for a provider with
 * a connect flow: a Claude subscription's tokens live in its own
 * `CLAUDE_CONFIG_DIR` and the router must never hold one (CLAUDE.md
 * non-negotiable 1), and offering a paste box for an OAuth provider would invite
 * an operator to hand-extract a token instead of pressing Connect.
 */
export function AccountEditDialog(props: AccountEditDialogProps) {
  const [label, setLabel] = createSignal("")
  const [credential, setCredential] = createSignal("")
  const [baseUrl, setBaseUrl] = createSignal("")
  const [dialect, setDialect] = createSignal("")
  const [supportedModels, setSupportedModels] = createSignal("")
  const [aliases, setAliases] = createSignal("")
  const [weight, setWeight] = createSignal("")
  const [priority, setPriority] = createSignal("")
  const [billing, setBilling] = createSignal<AccountBilling>("metered")

  // Sync-from-props, re-seeded whenever the dialog opens on a different account.
  // The credential is deliberately not among them: there is nothing to seed it
  // from, and a placeholder that looked like one would be a lie about what the
  // console can see.
  createEffect(
    on(
      () => (props.open ? props.account : null),
      (account) => {
        setLabel(account?.label ?? "")
        setCredential("")
        setBaseUrl(account?.baseUrl ?? "")
        setDialect(account?.dialect ?? "")
        setSupportedModels(formatModelList(account?.supportedModels ?? null))
        setAliases(formatModelAliases(account?.modelAliases ?? null))
        setWeight(account === null ? "" : String(account.weight))
        setPriority(account === null ? "" : String(account.priority))
        setBilling(account?.billing ?? "metered")
      },
    ),
  )

  const rotatable = () => (props.provider?.connectFlow ?? null) === null
  const credentialOptional = () => props.provider?.authKind === "none"

  const dialectOptions = createMemo<readonly SelectOption[]>(() => [
    { value: "", label: "Provider default" },
    ...(props.provider?.supportedDialects ?? []).map((value) => ({ value, label: value })),
  ])

  /** Refused before the request, in the operator's own line numbers rather than as a 400. */
  const aliasError = () => {
    const parsed = parseModelAliases(aliases())
    return parsed.ok ? null : parsed.error
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const account = props.account
    const parsedAliases = parseModelAliases(aliases())
    if (account === null || !parsedAliases.ok) return

    const models = parseModelList(supportedModels())
    const aliasMap = parsedAliases.aliases

    props.onSubmit({
      label: label().trim(),
      // Absent means "keep the stored one". Never sent empty — that would be a
      // rotation to nothing, which the API refuses and the operator did not ask for.
      ...(credential().length > 0 ? { credential: credential() } : {}),
      // `null` clears, so an emptied box returns the account to the provider default.
      baseUrl: baseUrl().trim().length > 0 ? baseUrl().trim() : null,
      dialect: dialect().length > 0 ? (dialect() as Dialect) : null,
      supportedModels: models.length > 0 ? models : null,
      modelAliases: Object.keys(aliasMap).length > 0 ? aliasMap : null,
      ...numeric("weight", weight(), account.weight),
      ...numeric("priority", priority(), account.priority),
      // Stated every time, like every other field this form owns: `PATCH` reads an absent field as
      // "leave it", and a control the operator can see but that sends nothing is a control that
      // silently does not work. Withheld only where the provider is the answer — sending one there
      // is a write the API refuses whichever value it carries.
      ...(props.provider?.billingFixed === true ? {} : { billing: billing() }),
    })
  }

  return (
    <Modal
      description="Everything here is the account, not the pool: a pool membership carries its own weight and priority, and those win where they are set."
      footer={
        <>
          <Button onClick={() => props.onClose()} tone="ghost">
            Cancel
          </Button>
          <Button busy={props.busy} form="account-edit-form" tone="primary" type="submit">
            Save account
          </Button>
        </>
      }
      onClose={() => props.onClose()}
      open={props.open && props.account !== null}
      title={props.account === null ? "Edit account" : `Edit ${props.account.label}`}
    >
      <form class={styles.form} id="account-edit-form" onSubmit={submit}>
        <TextField
          hint="How you will recognise it in a table of five near-identical subscriptions."
          label="Label"
          onInput={(event) => setLabel(event.currentTarget.value)}
          required
          value={label()}
        />

        <p class={styles.note}>
          Provider: <code>{props.account?.provider}</code> — not editable. It decides the driver,
          the credential rule and the dialects this account serves, so a different provider is a
          different account.
        </p>

        <Show when={rotatable()}>
          <TextField
            autocomplete="off"
            hint={
              credentialOptional()
                ? "Leave empty to keep what is stored. This upstream authenticates nobody, so it may hold none at all."
                : "Leave empty to keep the stored one. Typing here replaces it — nothing is returned by any endpoint, in any form."
            }
            label="Rotate credential"
            onInput={(event) => setCredential(event.currentTarget.value)}
            placeholder="unchanged"
            type="password"
            value={credential()}
          />
        </Show>

        <Show when={!rotatable()}>
          <p class={styles.note}>
            This account is logged in, not pasted — use <strong>Connect</strong> on its row. The
            router holds no credential for it to rotate.
          </p>
        </Show>

        <TextField
          hint="Where this account is reached. Empty falls back to the provider's pinned endpoint; set it to point one account at a proxy or a self-hosted deployment."
          label="Base URL"
          onInput={(event) => setBaseUrl(event.currentTarget.value)}
          required={props.provider?.requiresBaseUrl === true}
          type="url"
          value={baseUrl()}
        />

        <Show when={(props.provider?.supportedDialects.length ?? 0) > 1}>
          <SelectField
            hint="The wire protocol this account is addressed on. Leave on the default unless you know it serves another."
            label="Dialect"
            onChange={(event) => setDialect(event.currentTarget.value)}
            options={dialectOptions()}
            value={dialect()}
          />
        </Show>

        <TextField
          hint="Comma-separated, upstream-side. Empty means this account accepts any model a client names — and contributes nothing to GET /v1/models."
          label="Models it serves"
          onInput={(event) => setSupportedModels(event.currentTarget.value)}
          placeholder="glm-4.6, glm-4.7"
          value={supportedModels()}
        />

        <Show when={props.provider?.billingFixed === false}>
          <SelectField
            hint="How you pay for this account, and the only thing that decides whether its usage reports as spend or as an attribution. The router cannot read it off the wire — a coding plan and a metered key share an endpoint and a key shape."
            label="Billing"
            onChange={(event) => setBilling(event.currentTarget.value as AccountBilling)}
            options={BILLING_OPTIONS}
            value={billing()}
          />
          <p class={styles.note}>{billingConsequence(billing())}</p>
        </Show>

        <Show when={props.provider?.billingFixed === true}>
          <p class={styles.note}>
            Billing: <code>{props.account?.billing}</code> — not editable. This provider is sold
            only as a subscription and has no per-token price to meter, so its usage is always
            valued at the vendor's public API rate and reported apart from metered spend.
          </p>
        </Show>

        <Field
          hint="One per line, requested = upstream. The left side is what a client sends, the right is the name that goes upstream — the only rename the router is allowed to make."
          label="Model aliases"
        >
          {(ids) => (
            <textarea
              aria-describedby={ids.describedBy}
              autocomplete="off"
              class={styles.aliases}
              id={ids.id}
              onInput={(event) => setAliases(event.currentTarget.value)}
              placeholder="claude-sonnet-4-5 = glm-4.6"
              rows={3}
              spellcheck={false}
              value={aliases()}
            />
          )}
        </Field>

        <Show when={aliasError()}>
          {(message) => (
            <p class={styles.blocked} role="status">
              {message()}
            </p>
          )}
        </Show>

        <div class={styles.pair}>
          <TextField
            hint="Bias under the weighted policy. A pool membership's own weight wins where it is set."
            inputmode="numeric"
            label="Weight"
            max={10_000}
            min={1}
            onInput={(event) => setWeight(event.currentTarget.value)}
            required
            step={1}
            type="number"
            value={weight()}
          />
          <TextField
            hint="Order under priority-failover; lower is tried first. A pool membership's own priority wins where it is set."
            inputmode="numeric"
            label="Priority"
            max={10_000}
            min={0}
            onInput={(event) => setPriority(event.currentTarget.value)}
            required
            step={1}
            type="number"
            value={priority()}
          />
        </div>

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
 * A number box that is mid-retype holds no number, and sending `0` for it would
 * silently drop the account out of the `weighted` policy. An unreadable box
 * re-sends what the account already carries instead.
 */
function numeric(
  field: "weight" | "priority",
  raw: string,
  current: number,
): Record<string, number> {
  const parsed = Number.parseInt(raw, 10)
  return { [field]: Number.isFinite(parsed) ? parsed : current }
}
