import { SelectField, type SelectOption, TextField } from "../../components/Field"
import type { KeyOwnerKind } from "../../lib/api/types"
import styles from "./KeyAttributionFields.module.scss"

// The attribution half of the key form, split out of `KeyFormDialog` so neither
// outgrows its one responsibility. These are **labels for usage reports only**:
// no login, no role, no say in authentication. The name stays the free-text
// handle; owner/tool are its structured, slugged counterparts — which is why
// the "<owner>/<tool>" naming convention is documentation, never validated.

const OWNER_KINDS: readonly SelectOption[] = [
  { value: "none", label: "none" },
  { value: "person", label: "person" },
  { value: "service", label: "service" },
]

/** Same rule the API enforces, stated up front so the operator is not surprised by the 400. */
const SLUG_PATTERN = "[a-z0-9][a-z0-9._-]{0,63}"
const SLUG_RULE =
  "Lowercase slug — letters, digits, dots, underscores, hyphens; starts with a letter or digit."

export interface KeyAttributionFieldsProps {
  readonly owner: string
  readonly ownerKind: KeyOwnerKind | null
  readonly tool: string
  readonly purpose: string
  readonly onOwnerChange: (value: string) => void
  /** `null` is "none", the select's own spelling of an absent kind. */
  readonly onOwnerKindChange: (value: KeyOwnerKind | null) => void
  readonly onToolChange: (value: string) => void
  readonly onPurposeChange: (value: string) => void
}

export function KeyAttributionFields(props: KeyAttributionFieldsProps) {
  const ownerKindValue = () => props.ownerKind ?? "none"

  const changeOwnerKind = (event: Event) => {
    const value = (event.currentTarget as HTMLSelectElement).value
    props.onOwnerKindChange(value === "none" ? null : (value as KeyOwnerKind))
  }

  return (
    <fieldset class={styles.attribution}>
      <legend class={styles.legend}>Attribution (optional)</legend>

      <div class={styles.pair}>
        <TextField
          hint="Who this key belongs to. Attribution only — it never authenticates anything."
          label="Owner"
          onInput={(event) => props.onOwnerChange(event.currentTarget.value)}
          pattern={SLUG_PATTERN}
          placeholder="marta"
          title={SLUG_RULE}
          value={props.owner}
        />
        <SelectField
          hint="Whether the owner is a person or a service. A label, nothing more."
          label="Owner kind"
          onChange={changeOwnerKind}
          options={OWNER_KINDS}
          value={ownerKindValue()}
        />
      </div>

      <div class={styles.pair}>
        <TextField
          hint="Which tool presents this key, so usage reads per client."
          label="Tool"
          onInput={(event) => props.onToolChange(event.currentTarget.value)}
          pattern={SLUG_PATTERN}
          placeholder="claude-code"
          title={SLUG_RULE}
          value={props.tool}
        />
        <TextField
          hint="Free text, up to 500 characters. What this key is for."
          label="Purpose"
          maxlength="500"
          onInput={(event) => props.onPurposeChange(event.currentTarget.value)}
          placeholder="nightly builds"
          value={props.purpose}
        />
      </div>
    </fieldset>
  )
}
