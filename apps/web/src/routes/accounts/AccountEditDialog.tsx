import type { AccountBilling, Dialect, QuotaWindowKind } from "@multi-ai-router/core"
import { createEffect, createSignal, on, Show } from "solid-js"
import { Button } from "../../components/Button"
import { SelectField, TextField } from "../../components/Field"
import { Modal } from "../../components/Modal"
import {
  formatModelAliases,
  formatModelList,
  parseModelAliases,
  parseModelList,
  supportedModelsPatch,
} from "../../lib/account-models"
import type { UpdateAccountInput } from "../../lib/api/accounts"
import { errorMessage, isApiError } from "../../lib/api/errors"
import type { AccountView, ProviderDescriptor } from "../../lib/api/types"
import { endpointMove } from "../../lib/endpoint-move"
import { DIALECT_HINT, dialectChoices } from "../../lib/provider-display"
import styles from "./AccountEditDialog.module.scss"
import { BillingFields } from "./BillingFields"
import { CredentialRotateField } from "./CredentialRotateField"
import { EgressProxyPanel } from "./EgressProxyPanel"
import { LoginLifetimeSummary } from "./LoginLifetimeSummary"
import { ModelAliasesField } from "./ModelAliasesField"
import {
  formatPreferences,
  ProviderPreferencesField,
  parsePreferences,
} from "./ProviderPreferencesField"
import {
  type CeilingInputs,
  parseCeilings,
  QuotaCeilingFields,
  seedCeilings,
} from "./QuotaCeilingFields"
import { numeric, RoutingNumberFields } from "./RoutingNumberFields"

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

/** The API's refusal to send a stored key to a host it was not given for. */
const KEY_FOR_NEW_ENDPOINT = "credential_required_for_new_endpoint"

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
  const [ceilings, setCeilings] = createSignal<CeilingInputs>({})
  const [preferences, setPreferences] = createSignal("")

  // What the dialog opened on. `props.account` is a live row that follows every poll, so an edit
  // is diffed against this copy: an id discovered meanwhile is not one the operator removed.
  const [opened, setOpened] = createSignal<{
    readonly models: readonly string[]
    readonly baseUrl: string | null
    readonly dialect: string | null
  }>({ models: [], baseUrl: null, dialect: null })

  // Sync-from-props, re-seeded whenever the dialog opens on a different account.
  // The credential is deliberately not among them: there is nothing to seed it
  // from, and a placeholder that looked like one would be a lie about what the
  // console can see.
  createEffect(
    on(
      () => (props.open ? props.account : null),
      (account) => {
        setOpened({
          models: [...(account?.supportedModels ?? [])],
          baseUrl: account?.baseUrl ?? null,
          dialect: account?.dialect ?? null,
        })
        setLabel(account?.label ?? "")
        setCredential("")
        setBaseUrl(account?.baseUrl ?? "")
        setDialect(account?.dialect ?? "")
        setSupportedModels(formatModelList(account?.supportedModels ?? null))
        setAliases(formatModelAliases(account?.modelAliases ?? null))
        setWeight(account === null ? "" : String(account.weight))
        setPriority(account === null ? "" : String(account.priority))
        setBilling(account?.billing ?? "metered")
        setCeilings(seedCeilings(account?.windowTokenLimits))
        setPreferences(formatPreferences(account?.providerPreferences))
      },
    ),
  )

  const rotatable = () => (props.provider?.connectFlow ?? null) === null
  /** Only a stored key can be carried to the wrong host; an account holding none has none to leak. */
  const move = () => {
    if (props.account?.hasCredential !== true) return "same"
    const verdict = endpointMove(opened(), { baseUrl: baseUrl(), dialect: dialect() })
    // Where only the router can tell, its refusal of this save is the answer.
    const refused = isApiError(props.error) && props.error.code === KEY_FOR_NEW_ENDPOINT
    return verdict === "unknown" && refused ? "moved" : verdict
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const account = props.account
    const parsedAliases = parseModelAliases(aliases())
    const prefs = parsePreferences(preferences())
    const takesPreferences = props.provider?.providerPreferences === true
    if (account === null || !parsedAliases.ok || (takesPreferences && !prefs.ok)) return
    if (rotatable() && move() === "moved" && credential().length === 0) return

    const aliasMap = parsedAliases.aliases

    props.onSubmit({
      label: label().trim(),
      // Absent means "keep the stored one". Never sent empty — that would be a
      // rotation to nothing, which the API refuses and the operator did not ask for.
      ...(credential().length > 0 ? { credential: credential() } : {}),
      // `null` clears, so an emptied box returns the account to the provider default.
      baseUrl: baseUrl().trim().length > 0 ? baseUrl().trim() : null,
      dialect: dialect().length > 0 ? (dialect() as Dialect) : null,
      // Only when changed, with what it removes named (`supportedModelsPatch`).
      ...supportedModelsPatch(opened().models, parseModelList(supportedModels())),
      modelAliases: Object.keys(aliasMap).length > 0 ? aliasMap : null,
      ...numeric("weight", weight()),
      ...numeric("priority", priority()),
      // Stated every time, like every other field this form owns: `PATCH` reads an absent field as
      // "leave it", and a control the operator can see but that sends nothing is a control that
      // silently does not work. Withheld only where the provider is the answer — sending one there
      // is a write the API refuses whichever value it carries.
      ...(props.provider?.billingFixed === true ? {} : { billing: billing() }),
      // Same gate as the control itself: where the boxes are shown they are stated every save
      // (`null` clears), and where they are not, nothing is sent — an edit of an account whose
      // ceilings this form never displayed must not silently clear them.
      ...(props.provider?.transport === "agent-sdk"
        ? { windowTokenLimits: parseCeilings(ceilings()) }
        : {}),
      ...(takesPreferences && prefs.ok ? { providerPreferences: prefs.value } : {}),
    })
  }

  return (
    <Modal
      size="lg"
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
          <CredentialRotateField
            move={move()}
            onInput={setCredential}
            provider={props.provider}
            providerId={props.account?.provider ?? ""}
            value={credential()}
          />
        </Show>

        <Show when={!rotatable()}>
          <p class={styles.note}>
            This account is logged in, not pasted — use <strong>Connect</strong> on its row. The
            router holds no credential for it to rotate.
          </p>
          <LoginLifetimeSummary account={props.account} nowMs={Date.now()} />
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
            hint={DIALECT_HINT}
            label="Dialect"
            onChange={(event) => setDialect(event.currentTarget.value)}
            options={dialectChoices(props.provider)}
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

        <BillingFields
          onChange={setBilling}
          provider={props.provider}
          stored={props.account?.billing}
          value={billing()}
        />

        <ModelAliasesField onInput={setAliases} value={aliases()} />

        <ProviderPreferencesField
          onInput={setPreferences}
          shown={props.provider?.providerPreferences === true}
          value={preferences()}
        />

        <RoutingNumberFields
          onPriority={setPriority}
          onWeight={setWeight}
          priority={priority()}
          weight={weight()}
        />

        <QuotaCeilingFields
          onChange={(window: QuotaWindowKind, value: string) =>
            setCeilings((current) => ({ ...current, [window]: value }))
          }
          transport={props.provider?.transport}
          values={ceilings()}
        />

        <Show when={props.error !== undefined && props.error !== null}>
          <p class={styles.error} role="alert">
            {errorMessage(props.error)}
          </p>
        </Show>
      </form>
      {/* Beside the form, not in it: Enter in a proxy field must save the proxy, not the account. */}
      <EgressProxyPanel account={props.account} shown={rotatable()} />
    </Modal>
  )
}
