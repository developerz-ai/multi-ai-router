import type { KeyScope } from "@multi-ai-router/core"
import { createSignal, For, Show } from "solid-js"
import { Button } from "../../components/Button"
import { SelectField, TextField } from "../../components/Field"
import { Modal } from "../../components/Modal"
import { errorMessage } from "../../lib/api/errors"
import type { CreateKeyInput, KeyScopeInput } from "../../lib/api/router-keys"
import type { AccountView, PoolView } from "../../lib/api/types"
import styles from "./KeyFormDialog.module.scss"

const SCOPES: readonly (readonly [KeyScope, string])[] = [
  ["all", "all — every active account, skipping pools"],
  ["pools", "pools — the members of the pools you name"],
  ["accounts", "accounts — an explicit account list, ignoring pools"],
]

export interface KeyFormDialogProps {
  readonly open: boolean
  readonly pools: readonly PoolView[]
  readonly accounts: readonly AccountView[]
  readonly busy: boolean
  readonly error: unknown
  readonly onSubmit: (input: CreateKeyInput) => void
  readonly onClose: () => void
}

/**
 * Mint a router key.
 *
 * The name is required rather than optional-with-a-default: it is how the key is
 * found later and how its usage is attributed, and a fleet of keys called
 * "untitled" is the failure the requirement exists to prevent.
 *
 * Scope is enforced upstream as an **intersection** — candidates are always pool
 * members ∩ key scope. Naming a pool here does not widen anything; it narrows.
 */
export function KeyFormDialog(props: KeyFormDialogProps) {
  const [name, setName] = createSignal("")
  const [scope, setScope] = createSignal<KeyScope>("all")
  const [targets, setTargets] = createSignal<readonly string[]>([])
  const [requests, setRequests] = createSignal("")
  const [windowSeconds, setWindowSeconds] = createSignal("")
  const [expiresAt, setExpiresAt] = createSignal("")

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

  const rateLimit = () => {
    const count = Number.parseInt(requests(), 10)
    const seconds = Number.parseInt(windowSeconds(), 10)
    if (!Number.isFinite(count) || !Number.isFinite(seconds)) return undefined
    return { requests: count, windowSeconds: seconds }
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const resolved = buildScope()
    if (resolved === undefined) return

    const limit = rateLimit()
    const expiry = expiresAt()
    props.onSubmit({
      name: name().trim(),
      scope: resolved,
      ...(limit === undefined ? {} : { rateLimit: limit }),
      ...(expiry.length === 0 ? {} : { expiresAt: new Date(expiry).toISOString() }),
    })
  }

  return (
    <Modal
      description="Keys are named, stored encrypted, and readable again whenever you need them."
      footer={
        <>
          <Button onClick={() => props.onClose()} tone="ghost">
            Cancel
          </Button>
          <Button busy={props.busy} form="key-form" tone="primary" type="submit">
            Mint key
          </Button>
        </>
      }
      onClose={() => props.onClose()}
      open={props.open}
      title="Mint a router key"
    >
      <form class={styles.form} id="key-form" onSubmit={submit}>
        <TextField
          hint="How you will find this key later, and how its usage is attributed."
          label="Name"
          onInput={(event) => setName(event.currentTarget.value)}
          required
          value={name()}
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
            hint="Window in seconds. Both halves or neither."
            inputmode="numeric"
            label="Per (seconds)"
            min="1"
            onInput={(event) => setWindowSeconds(event.currentTarget.value)}
            type="number"
            value={windowSeconds()}
          />
        </div>

        <TextField
          hint="Optional. A key minted already expired serves exactly no requests, and the router says so."
          label="Expires at"
          onInput={(event) => setExpiresAt(event.currentTarget.value)}
          type="datetime-local"
          value={expiresAt()}
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
