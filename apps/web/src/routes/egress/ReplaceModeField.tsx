import { createSignal, Show } from "solid-js"
import { SelectField } from "../../components/Field"
import type { ReplaceMode } from "../../lib/api/egress"
import { errorMessage } from "../../lib/api/errors"
import { useSetReplaceMode } from "../../lib/queries/egress"
import styles from "./egress.module.scss"
import { REPLACE_OPTIONS } from "./egress-copy"

/** Saved on change. Disabled for a proxy typed in by hand, which has no vendor to pick another from. */
export function ReplaceModeField(props: {
  readonly accountId: string
  readonly accountLabel: string
  readonly mode: ReplaceMode
  readonly replaceable: boolean
}) {
  const save = useSetReplaceMode()
  // The choice in flight: dropped when the save settles, so a refused one goes back to the truth.
  const [choice, setChoice] = createSignal<ReplaceMode | null>(null)

  const change = (replace: ReplaceMode) => {
    setChoice(replace)
    save.mutate({ accountId: props.accountId, replace }, { onSettled: () => setChoice(null) })
  }

  return (
    <div class={styles.stack}>
      <SelectField
        aria-label={`If the proxy of ${props.accountLabel} dies`}
        disabled={!props.replaceable || save.isPending}
        hint={props.replaceable ? undefined : "Typed in by hand: no vendor to replace it from."}
        label="If it dies"
        onChange={(event) => change(event.currentTarget.value as ReplaceMode)}
        options={REPLACE_OPTIONS}
        value={choice() ?? props.mode}
      />
      <Show when={save.error}>
        {(error) => (
          <span class={styles.warn} role="alert">
            {errorMessage(error())}
          </span>
        )}
      </Show>
    </div>
  )
}
