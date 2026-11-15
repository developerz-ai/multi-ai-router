import { Show } from "solid-js"
import { Field } from "../../components/Field"
import type { AccountView } from "../../lib/api/types"
import styles from "./AccountEditDialog.module.scss"

/**
 * OpenRouter's request `provider` object as this account's standing preferences — `sort`,
 * `quantizations`, `allow_fallbacks`, `order`, `only`, `ignore`, `require_parameters` — merged into
 * every request the account is sent, a client's own fields winning. Edited as JSON because it *is*
 * OpenRouter's JSON, spelled as on its wire; the browser only checks it is an object, and the API
 * owns the field rules (an unknown field or value is its `400`, shown as the form's error).
 *
 * Rendered only where the provider descriptor says the surface reads the field; elsewhere the form
 * sends nothing, so an edit never clears preferences it never displayed.
 */

export type PreferencesParse =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> | null }
  | { readonly ok: false; readonly error: string }

/** Stored object → box contents. None opens empty. */
export function formatPreferences(value: AccountView["providerPreferences"]): string {
  return value === null || value === undefined ? "" : JSON.stringify(value, null, 2)
}

/** Box contents → the patch value. Empty is `null`, which clears. */
export function parsePreferences(raw: string): PreferencesParse {
  if (raw.trim().length === 0) return { ok: true, value: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ok: false, error: 'not a JSON object — write e.g. {"sort": "price"}' }
  return { ok: true, value: parsed as Record<string, unknown> }
}

export function ProviderPreferencesField(props: {
  readonly shown: boolean
  readonly value: string
  readonly onInput: (value: string) => void
}) {
  const error = () => {
    const parsed = parsePreferences(props.value)
    return parsed.ok ? null : parsed.error
  }
  return (
    <Show when={props.shown}>
      <Field
        hint="OpenRouter's provider routing object, sent with every request this account serves; a client's own provider fields win. Empty sends none."
        label="Provider preferences"
      >
        {(ids) => (
          <textarea
            aria-describedby={ids.describedBy}
            autocomplete="off"
            class={styles.aliases}
            id={ids.id}
            onInput={(event) => props.onInput(event.currentTarget.value)}
            placeholder='{"sort": "price", "quantizations": ["fp8", "bf16"], "allow_fallbacks": true}'
            rows={3}
            spellcheck={false}
            value={props.value}
          />
        )}
      </Field>
      <Show when={error()}>
        {(message) => (
          <p class={styles.blocked} role="status">
            Provider preferences: {message()}
          </p>
        )}
      </Show>
    </Show>
  )
}
