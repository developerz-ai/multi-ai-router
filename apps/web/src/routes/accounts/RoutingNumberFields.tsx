import { TextField } from "../../components/Field"
import { readNumberInput } from "../../lib/number-input"
import styles from "./RoutingNumberFields.module.scss"

export interface RoutingNumberFieldsProps {
  readonly weight: string
  readonly priority: string
  readonly onWeight: (value: string) => void
  readonly onPriority: (value: string) => void
}

/**
 * `required` + `type="number"` + `min`/`max` refuse an empty or out-of-range box in the browser
 * before submit can run — the same floor the API enforces (`WEIGHT = z.number().int().min(1)`).
 * Read with `readNumberInput`, so `1e3` is a thousand, not one. A box that still reads as nothing
 * leaves the field out rather than sending `NaN`.
 */
export function numeric(field: "weight" | "priority", raw: string): Record<string, number> {
  const value = readNumberInput(raw)
  return value === null ? {} : { [field]: value }
}

/**
 * The account's two routing numbers, side by side. Split out of `AccountEditDialog` purely as a
 * responsibility seam — the wording, bounds and required-ness are contract with the API's
 * `WEIGHT`/`PRIORITY` schemas and must not drift when the dialog is edited around them.
 */

export function RoutingNumberFields(props: RoutingNumberFieldsProps) {
  return (
    <div class={styles.pair}>
      <TextField
        hint="Bias under the weighted policy. A pool membership's own weight wins where it is set."
        inputmode="numeric"
        label="Weight"
        max={10_000}
        min={1}
        onInput={(event) => props.onWeight(event.currentTarget.value)}
        required
        step={1}
        type="number"
        value={props.weight}
      />
      <TextField
        hint="Order under priority-failover; lower is tried first. A pool membership's own priority wins where it is set."
        inputmode="numeric"
        label="Priority"
        max={10_000}
        min={0}
        onInput={(event) => props.onPriority(event.currentTarget.value)}
        required
        step={1}
        type="number"
        value={props.priority}
      />
    </div>
  )
}
