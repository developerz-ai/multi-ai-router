import { createEffect, createSignal, on, Show } from "solid-js"
import { SelectField } from "../../components/Field"
import type { FreePreset } from "../../lib/api/free-tier"
import styles from "./AccountFormDialog.module.scss"

export interface FreePresetFieldProps {
  readonly presets: readonly FreePreset[]
  /** Fills the form; undefined when the operator goes back to filling it in themselves. */
  readonly onChoose: (preset: FreePreset | undefined) => void
}

/** Free services reached over this provider: choosing one fills the base URL and the free ids. */
export function FreePresetField(props: FreePresetFieldProps) {
  const [id, setId] = createSignal("")
  const chosen = () => props.presets.find((preset) => preset.id === id())

  createEffect(
    on(
      () => props.presets,
      () => setId(""),
      { defer: true },
    ),
  )

  return (
    <Show when={props.presets.length > 0}>
      <SelectField
        hint="Optional. Fills in a service that gives tokens away, smartest models first; you still make the key."
        label="Free service"
        onChange={(event) => {
          setId(event.currentTarget.value)
          props.onChoose(chosen())
        }}
        options={[
          { value: "", label: "None — I have my own endpoint" },
          ...props.presets.map((preset) => ({
            value: preset.id,
            label: preset.kind === "trial" ? `${preset.name} — one-time or dated` : preset.name,
          })),
        ]}
        value={id()}
      />
      <Show when={chosen()}>
        {(preset) => (
          <div class={styles.providerNote}>
            <p>
              {preset().note}{" "}
              <a href={preset().keyUrl} rel="noreferrer" target="_blank">
                Get a key
              </a>
            </p>
          </div>
        )}
      </Show>
    </Show>
  )
}
