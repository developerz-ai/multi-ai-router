import { Show } from "solid-js"
import { Button } from "../../components/Button"
import { SelectField, TextField } from "../../components/Field"
import type { ProviderDescriptor } from "../../lib/api/types"
import styles from "./PriceAddForm.module.scss"

export interface PriceAddFormProps {
  /** The registry, so the provider list is never a second copy of `providers/`. */
  readonly providers: readonly ProviderDescriptor[]
  readonly provider: string
  readonly model: string
  /** The refusal from the last attempt — a duplicate row, or a missing field. */
  readonly error: string | null
  readonly onProvider: (provider: string) => void
  readonly onModel: (model: string) => void
  readonly onAdd: () => void
}

/**
 * Pricing a model the image does not price.
 *
 * Controlled by the section rather than holding its own state: everything on this
 * screen that survives a background refetch has to live above the query boundary.
 * The row it adds starts blank and is filled in the table like any other, so
 * there is one place to type a rate rather than two.
 */
export function PriceAddForm(props: PriceAddFormProps) {
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    props.onAdd()
  }

  return (
    <form class={styles.form} onSubmit={submit}>
      <SelectField
        hint="Rates are per provider: the same model costs different money upstream to upstream."
        label="Provider"
        onChange={(event) => props.onProvider(event.currentTarget.value)}
        options={[
          { value: "", label: "Choose a provider" },
          ...props.providers.map((descriptor) => ({
            value: descriptor.id,
            label: descriptor.id,
          })),
        ]}
        value={props.provider}
      />
      <TextField
        hint="Exactly as clients ask for it. Stored lowercase, so one model is one row."
        label="Model"
        onInput={(event) => props.onModel(event.currentTarget.value)}
        value={props.model}
      />
      <Button class={styles.action} tone="neutral" type="submit">
        Add model
      </Button>

      <Show when={props.error}>
        {(message) => (
          <p class={styles.error} role="alert">
            {message()}
          </p>
        )}
      </Show>
    </form>
  )
}
