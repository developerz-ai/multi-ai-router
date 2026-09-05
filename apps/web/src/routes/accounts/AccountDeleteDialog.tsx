import { Show } from "solid-js"
import { ConfirmDialog } from "../../components/ConfirmDialog"
import type { AccountView } from "../../lib/api/types"
import { deleteConsequences } from "./account-cells"

export interface AccountDeleteDialogProps {
  /** Null while nothing is pending — the dialog is not rendered. */
  readonly account: AccountView | null
  readonly busy: boolean
  readonly error: unknown
  readonly onClose: () => void
  readonly onConfirm: (account: AccountView) => void
}

/**
 * Deleting an account, with exactly what breaks spelled out (`deleteConsequences`). The server's
 * refusal — a 409 naming every key whose scope this would narrow — lands in `error` and is
 * rendered verbatim by `ConfirmDialog`, which is the decisive sentence and never ours to soften.
 */
export function AccountDeleteDialog(props: AccountDeleteDialogProps) {
  return (
    <Show when={props.account}>
      {(account) => (
        <ConfirmDialog
          busy={props.busy}
          confirmLabel="Delete account"
          consequences={deleteConsequences(account())}
          error={props.error}
          onClose={props.onClose}
          onConfirm={() => props.onConfirm(account())}
          open
          subject={account().label}
          title="Delete this account?"
        />
      )}
    </Show>
  )
}
