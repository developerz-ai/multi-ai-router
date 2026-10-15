import { Show } from "solid-js"
import { ConfirmDialog } from "../../components/ConfirmDialog"
import type { ApiKeyView } from "../../lib/api/types"

export interface KeyDangerDialogsProps {
  readonly pendingRevoke: ApiKeyView | null
  readonly pendingDelete: ApiKeyView | null
  readonly revokeBusy: boolean
  readonly revokeError: unknown
  readonly deleteBusy: boolean
  readonly deleteError: unknown
  readonly onRevokeConfirm: (key: ApiKeyView) => void
  readonly onDeleteConfirm: (key: ApiKeyView) => void
  readonly onRevokeClose: () => void
  readonly onDeleteClose: () => void
}

/**
 * The two one-way doors on a router key, split out of `KeysRoute` so the route
 * stays wiring-only. What they say is load-bearing: a destructive action names
 * exactly what breaks — which clients stop working — rather than a generic
 * "this cannot be undone".
 */
export function KeyDangerDialogs(props: KeyDangerDialogsProps) {
  return (
    <>
      <Show when={props.pendingRevoke}>
        {(key) => (
          <ConfirmDialog
            busy={props.revokeBusy}
            confirmLabel="Revoke key"
            consequences={revokeConsequences(key())}
            error={props.revokeError}
            onClose={props.onRevokeClose}
            onConfirm={() => props.onRevokeConfirm(key())}
            open
            subject={key().name}
            title="Revoke this key?"
          />
        )}
      </Show>

      <Show when={props.pendingDelete}>
        {(key) => (
          <ConfirmDialog
            busy={props.deleteBusy}
            confirmLabel="Delete key"
            consequences={deleteConsequences(key())}
            error={props.deleteError}
            onClose={props.onDeleteClose}
            onConfirm={() => props.onDeleteConfirm(key())}
            open
            subject={key().name}
            title="Delete this key?"
          />
        )}
      </Show>
    </>
  )
}

/** Exactly what breaks — named clients, not "this cannot be undone". */
function revokeConsequences(key: ApiKeyView): readonly string[] {
  return [
    `Every client presenting "${key.name}" starts failing on its next request. In-flight requests finish.`,
    "Revocation is one-way. Mint a replacement and hand it out before revoking, not after.",
    "The key stays listed and its usage history stays attributable.",
  ]
}

function deleteConsequences(key: ApiKeyView): readonly string[] {
  return [
    `"${key.name}" is removed outright — clients presenting it fail immediately.`,
    "Its usage rows survive, but they no longer name a key.",
    "Revoke is the softer door: it stops the key while keeping the row and its scope visible.",
  ]
}
