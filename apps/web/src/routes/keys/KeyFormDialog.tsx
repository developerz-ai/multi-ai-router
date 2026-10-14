import type { KeyScope } from "@multi-ai-router/core"
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { Button } from "../../components/Button"
import { SelectField, TextField } from "../../components/Field"
import { Modal } from "../../components/Modal"
import { errorMessage } from "../../lib/api/errors"
import type { KeyScopeInput, RateLimitInput } from "../../lib/api/router-keys"
import type { AccountView, ApiKeyView, KeyOwnerKind, PoolView } from "../../lib/api/types"
import { fromDateTimeInput, toDateTimeInput } from "../../lib/datetime-input"
import { KeyAttributionFields } from "./KeyAttributionFields"
import styles from "./KeyFormDialog.module.scss"
import { type KeyFormValues, labelOrNull } from "./key-form-values"

// Re-exported because the dialog's other caller — the onboarding panel — mints
// through the same contract. `key-form-values.ts` is the home, not this file.
export { type KeyFormValues, toCreateKeyInput } from "./key-form-values"

const SCOPES: readonly (readonly [KeyScope, string])[] = [
  ["all", "all — every active account, skipping pools"],
  ["pools", "pools — the members of the pools you name"],
  ["accounts", "accounts — an explicit account list, ignoring pools"],
]

export interface KeyFormDialogProps {
  readonly open: boolean
  /** `null` mints a new key; a key edits that one. The value is never touched either way. */
  readonly apiKey: ApiKeyView | null
  /**
   * Mints a **successor** to this key: its attribution, scope and ceiling seed
   * the form, the name starts empty, and the expiry is never inherited — a
   * lifetime is per key. Null for a plain mint or an edit.
   */
  readonly successorOf: ApiKeyView | null
  readonly pools: readonly PoolView[]
  readonly accounts: readonly AccountView[]
  readonly busy: boolean
  readonly error: unknown
  readonly onSubmit: (values: KeyFormValues) => void
  readonly onClose: () => void
}

/**
 * Mint or edit a router key.
 *
 * The name is required rather than optional-with-a-default: it is how the key is
 * found later and how its usage is attributed, and a fleet of keys called
 * "untitled" is the failure the requirement exists to prevent.
 *
 * Scope is enforced upstream as an **intersection** — candidates are always pool
 * members ∩ key scope. Naming a pool here does not widen anything; it narrows.
 *
 * **Editing never changes the value.** There is no field for one and no rotate
 * endpoint behind this form: keys are stored encrypted rather than hashed, so a
 * key that needs different limits or a different scope is edited in place and
 * every client holding it keeps working.
 */
export function KeyFormDialog(props: KeyFormDialogProps) {
  const [name, setName] = createSignal("")
  const [owner, setOwner] = createSignal("")
  const [ownerKind, setOwnerKind] = createSignal<KeyOwnerKind | null>(null)
  const [tool, setTool] = createSignal("")
  const [purpose, setPurpose] = createSignal("")
  const [scope, setScope] = createSignal<KeyScope>("all")
  const [targets, setTargets] = createSignal<readonly string[]>([])
  const [requests, setRequests] = createSignal("")
  const [windowSeconds, setWindowSeconds] = createSignal("")
  const [expiresAt, setExpiresAt] = createSignal("")

  // Re-seeded whenever the dialog opens, on the key it opened on — `on` with the
  // key as its source keeps this a sync-from-props effect rather than a place
  // where state is derived. Opening the mint form (`apiKey: null`) clears it,
  // so a mint never inherits the last edited key's scope. A successor seed fills
  // everything except the name and the expiry, which belong to the new key alone.
  createEffect(
    on(
      () => (props.open ? { edit: props.apiKey, seed: props.successorOf } : null),
      (opened) => {
        // `on` fires with null while the dialog is closed — seeding nothing is
        // the point: a closed form holds no state worth keeping.
        const edit = opened?.edit ?? null
        const seed = opened?.seed ?? null
        const from = edit ?? seed
        setName(edit?.name ?? "")
        setOwner(from?.owner ?? "")
        setOwnerKind(from?.ownerKind ?? null)
        setTool(from?.tool ?? "")
        setPurpose(from?.purpose ?? "")
        setScope(from?.scope.kind ?? "all")
        setTargets(from === null ? [] : scopeTargets(from))
        setRequests(from?.rateLimit ? String(from.rateLimit.requests) : "")
        setWindowSeconds(from?.rateLimit ? String(from.rateLimit.windowSeconds) : "")
        setExpiresAt(toDateTimeInput(edit?.expiresAt ?? null))
      },
    ),
  )

  const editing = () => props.apiKey !== null
  const options = () => (scope() === "pools" ? props.pools : props.accounts)

  const toggle = (id: string) => {
    setTargets((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    )
  }

  const changeScope = (next: KeyScope) => {
    setScope(next)
    setTargets([])
  }

  const buildScope = (): KeyScopeInput | undefined => {
    if (scope() === "all") return { kind: "all" }
    if (targets().length === 0) return undefined
    return scope() === "pools"
      ? { kind: "pools", poolIds: targets() }
      : { kind: "accounts", accountIds: targets() }
  }

  /**
   * Both halves or neither: a count with no window is not a rate limit, and the
   * API refuses one. An empty pair is `null` — no ceiling — which on an edit is
   * how an existing one is removed.
   */
  const rateLimit = (): RateLimitInput | null => {
    const count = Number.parseInt(requests(), 10)
    const seconds = Number.parseInt(windowSeconds(), 10)
    if (!Number.isFinite(count) || !Number.isFinite(seconds)) return null
    return { requests: count, windowSeconds: seconds }
  }

  /** Named, not silent: a submit that does nothing reads as a broken button. */
  const blocker = () =>
    buildScope() === undefined
      ? `Choose at least one ${scope() === "pools" ? "pool" : "account"}, or set the scope to "all".`
      : null

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const resolved = buildScope()
    if (resolved === undefined) return

    props.onSubmit({
      name: name().trim(),
      owner: labelOrNull(owner()),
      ownerKind: ownerKind(),
      tool: labelOrNull(tool()),
      purpose: labelOrNull(purpose()),
      scope: resolved,
      rateLimit: rateLimit(),
      expiresAt: fromDateTimeInput(expiresAt()),
    })
  }

  return (
    <Modal
      size="lg"
      description="Keys are named, stored encrypted, and readable again whenever you need them. Editing one never changes its value."
      footer={
        <>
          <Button onClick={() => props.onClose()} tone="ghost">
            Cancel
          </Button>
          <Button busy={props.busy} form="key-form" tone="primary" type="submit">
            {editing() ? "Save key" : "Mint key"}
          </Button>
        </>
      }
      onClose={() => props.onClose()}
      open={props.open}
      title={props.apiKey === null ? "Mint a router key" : `Edit ${props.apiKey.name}`}
    >
      <form class={styles.form} id="key-form" onSubmit={submit}>
        <TextField
          hint="How you will find this key later, and how its usage is attributed."
          label="Name"
          onInput={(event) => setName(event.currentTarget.value)}
          required
          value={name()}
        />

        <KeyAttributionFields
          onOwnerChange={setOwner}
          onOwnerKindChange={setOwnerKind}
          onPurposeChange={setPurpose}
          onToolChange={setTool}
          owner={owner()}
          ownerKind={ownerKind()}
          purpose={purpose()}
          tool={tool()}
        />

        <SelectField
          hint="Enforced as an intersection: candidates are always pool members ∩ this scope. It can only narrow."
          label="Scope"
          onChange={(event) => changeScope(event.currentTarget.value as KeyScope)}
          options={SCOPES.map(([value, label]) => ({ value, label }))}
          value={scope()}
        />

        <Show when={scope() !== "all"}>
          <fieldset class={styles.targets}>
            <legend class={styles.legend}>
              {scope() === "pools" ? "Pools" : "Accounts"} ({targets().length} selected)
            </legend>
            <Show
              fallback={
                <p class={styles.empty}>
                  Nothing to choose from yet — create{" "}
                  {scope() === "pools" ? "a pool" : "an account"} first.
                </p>
              }
              when={options().length > 0}
            >
              <ul class={styles.list}>
                <For each={options()}>
                  {(option) => (
                    <li>
                      <label class={styles.target}>
                        <input
                          checked={targets().includes(option.id)}
                          class={styles.checkbox}
                          onChange={() => toggle(option.id)}
                          type="checkbox"
                        />
                        <span>{"name" in option ? option.name : option.label}</span>
                      </label>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </fieldset>
        </Show>

        <div class={styles.pair}>
          <TextField
            hint="Optional ceiling for this key."
            inputmode="numeric"
            label="Requests"
            min="1"
            onInput={(event) => setRequests(event.currentTarget.value)}
            type="number"
            value={requests()}
          />
          <TextField
            hint="Window in seconds. Both halves or neither — empty both to remove the ceiling."
            inputmode="numeric"
            label="Per (seconds)"
            min="1"
            onInput={(event) => setWindowSeconds(event.currentTarget.value)}
            type="number"
            value={windowSeconds()}
          />
        </div>

        <TextField
          hint="Optional, in this browser's timezone. Empty means it never expires. A key set to expire in the past serves exactly no requests, and the router says so."
          label="Expires at"
          onInput={(event) => setExpiresAt(event.currentTarget.value)}
          type="datetime-local"
          value={expiresAt()}
        />

        <Show when={blocker()}>
          {(message) => (
            <p class={styles.blocked} role="status">
              {message()}
            </p>
          )}
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

/** The ids a stored scope already names, so an edit opens on the key's own selection. */
function scopeTargets(key: ApiKeyView | null): readonly string[] {
  switch (key?.scope.kind) {
    case "pools":
      return key.scope.poolIds
    case "accounts":
      return key.scope.accountIds
    default:
      return []
  }
}
