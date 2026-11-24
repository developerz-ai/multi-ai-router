import { Show } from "solid-js"
import { TextField } from "../../components/Field"
import type { ProviderDescriptor } from "../../lib/api/types"
import type { endpointMove } from "../../lib/endpoint-move"
import { providerCredentialNote } from "../../lib/provider-display"
import styles from "./AccountEditDialog.module.scss"

/**
 * The write-only credential box. Empty keeps the stored one, with one exception: an edit that
 * points the account at another host must carry the key, or the stored one would go there.
 */
export function CredentialRotateField(props: {
  readonly provider: ProviderDescriptor | undefined
  readonly providerId: string
  readonly value: string
  readonly move: ReturnType<typeof endpointMove>
  readonly onInput: (value: string) => void
}) {
  const hint = () =>
    props.provider?.authKind === "none"
      ? "Leave empty to keep what is stored. This upstream authenticates nobody, so it may hold none at all."
      : "Leave empty to keep the stored one. Typing here replaces it — nothing is returned by any endpoint, in any form."

  return (
    <>
      <Show when={providerCredentialNote(props.providerId)}>
        {(note) => <p class={styles.note}>{note()}</p>}
      </Show>
      <TextField
        autocomplete="new-password"
        hint={hint()}
        label="Rotate credential"
        onInput={(event) => props.onInput(event.currentTarget.value)}
        placeholder={props.move === "moved" ? "" : "unchanged"}
        required={props.move === "moved"}
        type="password"
        value={props.value}
      />
      <Show when={props.move !== "same"}>
        <p class={styles.blocked} role="status">
          {props.move === "moved"
            ? "This edit moves the account to another host. The stored key is never sent to a new host, so type the key that endpoint takes."
            : "If this edit changes the host the account is reached on, type the key again: the stored one is never sent to a new host, and the router refuses the save without it."}
        </p>
      </Show>
    </>
  )
}
