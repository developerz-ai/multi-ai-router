import { Show } from "solid-js"
import { ConfirmDialog } from "../../components/ConfirmDialog"
import type { AccountView, PoolView } from "../../lib/api/types"
import { useDisableAccount } from "../../lib/queries/accounts"
import { disableConsequences } from "./account-cells"

export interface AccountDisableDialogProps {
  /** Null while nothing is pending — the dialog is not rendered. */
  readonly account: AccountView | null
  readonly pools: readonly PoolView[]
  readonly onClose: () => void
}

/**
 * Disabling takes an account out of live traffic, and the button sits beside Edit on every row. It
 * owns its mutation so a refusal lands in this dialog: fired straight from the row, it had nowhere
 * to render and the press simply did nothing.
 */
export function AccountDisableDialog(props: AccountDisableDialogProps) {
  const disable = useDisableAccount()

  const close = () => {
    disable.reset()
    props.onClose()
  }

  return (
    <Show when={props.account}>
      {(account) => (
        <ConfirmDialog
          busy={disable.isPending}
          confirmLabel="Disable account"
          consequences={disableConsequences(account(), props.pools)}
          error={disable.error}
          onClose={close}
          onConfirm={() => disable.mutate(account().id, { onSuccess: close })}
          open
          subject={account().label}
          title="Disable this account?"
        />
      )}
    </Show>
  )
}
