import { Show } from "solid-js"
import { Field } from "../../components/Field"
import { parseModelAliases } from "../../lib/account-models"
import styles from "./AccountEditDialog.module.scss"

/** The account's alias map, one `requested = upstream` per line, refused in the operator's own line numbers. */
export function ModelAliasesField(props: {
  readonly value: string
  readonly onInput: (value: string) => void
}) {
  const error = () => {
    const parsed = parseModelAliases(props.value)
    return parsed.ok ? null : parsed.error
  }
  return (
    <>
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
            onInput={(event) => props.onInput(event.currentTarget.value)}
            placeholder="claude-sonnet-5-5 = glm-4.6"
            rows={3}
            spellcheck={false}
            value={props.value}
          />
        )}
      </Field>
      <Show when={error()}>
        {(message) => (
          <p class={styles.blocked} role="status">
            {message()}
          </p>
        )}
      </Show>
    </>
  )
}
