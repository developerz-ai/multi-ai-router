import { createEffect, createUniqueId, For, type JSX, Show, splitProps } from "solid-js"
import { cx } from "../lib/cx"
import styles from "./Field.module.scss"

// The form-control family. One module, because a label, its control and its
// hint are one component split across three elements — styling them from
// separate modules would mean a parent reaching into a child's rules, which is
// the thing the SCSS convention forbids.
//
// Every control here is labelled by a real `<label for>` and describes its hint
// through `aria-describedby`. Placeholder-as-label is not used anywhere: it
// disappears on focus, which is precisely when the operator needs it.

export interface FieldProps {
  readonly label: string
  /** Rendered under the control, and wired up as its description. */
  readonly hint?: string
  readonly required?: boolean
  /** Receives the generated ids to wire onto the control. */
  readonly children: (ids: { readonly id: string; readonly describedBy: string }) => JSX.Element
}

export function Field(props: FieldProps) {
  const id = createUniqueId()
  const describedBy = createUniqueId()

  return (
    <div class={styles.field}>
      <label class={styles.label} for={id}>
        {props.label}
        <Show when={props.required === true}>
          <span class={styles.required} title="Required">
            *
          </span>
        </Show>
      </label>
      {props.children({ id, describedBy })}
      <Show when={props.hint}>
        {(hint) => (
          <p class={styles.hint} id={describedBy}>
            {hint()}
          </p>
        )}
      </Show>
    </div>
  )
}

export interface TextFieldProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
  readonly label: string
  readonly hint?: string
}

export function TextField(props: TextFieldProps) {
  const [local, rest] = splitProps(props, ["label", "hint", "class"])

  return (
    <Field hint={local.hint} label={local.label} required={rest.required === true}>
      {(ids) => (
        <input
          {...rest}
          aria-describedby={local.hint === undefined ? undefined : ids.describedBy}
          class={cx(styles.control, local.class)}
          id={ids.id}
        />
      )}
    </Field>
  )
}

export interface SelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

export interface SelectFieldProps extends JSX.SelectHTMLAttributes<HTMLSelectElement> {
  readonly label: string
  readonly hint?: string
  readonly options: readonly SelectOption[]
}

export function SelectField(props: SelectFieldProps) {
  const [local, rest] = splitProps(props, ["label", "hint", "options", "class"])
  let element: HTMLSelectElement | undefined

  /**
   * A spread assigns `value` to the `<select>` *before* the `<For>` appends any `<option>`, and
   * a browser silently drops a value no option carries — so without this, a control opened on
   * anything but its first option renders the wrong selection, and so does one whose options
   * arrive from a query after mount. Re-applied once both sides exist, and again whenever
   * either changes. Skipped when nothing matches, rather than forcing a selection that is not
   * on offer.
   */
  createEffect(() => {
    const value = rest.value
    const options = local.options
    if (element === undefined || (typeof value !== "string" && typeof value !== "number")) return
    const wanted = String(value)
    if (options.some((option) => option.value === wanted)) element.value = wanted
  })

  return (
    <Field hint={local.hint} label={local.label} required={rest.required === true}>
      {(ids) => (
        <select
          {...rest}
          aria-describedby={local.hint === undefined ? undefined : ids.describedBy}
          class={cx(styles.control, styles.select, local.class)}
          id={ids.id}
          ref={(node) => {
            element = node
          }}
        >
          <For each={local.options}>
            {(option) => (
              <option disabled={option.disabled === true} value={option.value}>
                {option.label}
              </option>
            )}
          </For>
        </select>
      )}
    </Field>
  )
}
