import type { AccountBilling } from "@multi-ai-router/core"
import { Show } from "solid-js"
import { SelectField } from "../../components/Field"
import type { ProviderDescriptor } from "../../lib/api/types"
import { BILLING_OPTIONS, billingConsequence } from "../../lib/billing"
import styles from "./AccountEditDialog.module.scss"

/**
 * The account edit form's billing control: a choice where the provider sells both ways, a
 * read-only statement where it is sold only as a subscription. Split out of `AccountEditDialog.tsx`
 * by responsibility; the dialog still owns the value and states it on every save.
 */
export function BillingFields(props: {
  readonly provider: ProviderDescriptor | undefined
  readonly stored: AccountBilling | undefined
  readonly value: AccountBilling
  readonly onChange: (value: AccountBilling) => void
}) {
  return (
    <>
      <Show when={props.provider?.billingFixed === false}>
        <SelectField
          hint="How you pay for this account, and the only thing that decides whether its usage reports as spend or as an attribution. The router cannot read it off the wire — a coding plan and a metered key share an endpoint and a key shape."
          label="Billing"
          onChange={(event) => props.onChange(event.currentTarget.value as AccountBilling)}
          options={BILLING_OPTIONS}
          value={props.value}
        />
        <p class={styles.note}>{billingConsequence(props.value)}</p>
      </Show>

      <Show when={props.provider?.billingFixed === true}>
        <p class={styles.note}>
          Billing: <code>{props.stored}</code> — not editable. This provider is sold only as a
          subscription and has no per-token price to meter, so its usage is always valued at the
          vendor's public API rate and reported apart from metered spend.
        </p>
      </Show>
    </>
  )
}
