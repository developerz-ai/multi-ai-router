import { Show } from "solid-js"
import type { ProviderDescriptor } from "../../lib/api/types"
import { providerCredentialNote } from "../../lib/provider-display"
import styles from "./AccountFormDialog.module.scss"

export interface ProviderNotesProps {
  readonly provider: ProviderDescriptor | undefined
}

/** What the add form says about the chosen provider, above the fields that provider asks for. */
export function ProviderNotes(props: ProviderNotesProps) {
  return (
    <>
      <Show when={props.provider}>
        {(provider) => (
          <div class={styles.providerNote}>
            <Show when={provider().reason}>{(reason) => <p>{reason()}</p>}</Show>
            <p>
              Transport: {provider().transport}
              {provider().authKind === null ? "" : ` · auth: ${provider().authKind}`}
            </p>
          </div>
        )}
      </Show>

      <Show when={props.provider?.requiresConfigDir === true}>
        <div class={styles.providerNote}>
          <p>
            This account gets a <code>CLAUDE_CONFIG_DIR</code> of its own on the persistent volume,
            named after its id and created with it. Nothing to fill in: the Agent SDK owns the
            credentials inside it and the router never reads them.
          </p>
        </div>
      </Show>

      <Show when={props.provider?.connectFlow === "oauth"}>
        <div class={styles.providerNote}>
          <p>
            This provider is logged in, not pasted. Add the account first — it exists so the
            authorization can bind to it — then choose <strong>Connect</strong> on its row. The
            router performs the code exchange itself and stores only the resulting credential,
            encrypted.
          </p>
        </div>
      </Show>

      <Show when={props.provider?.authKind === "none"}>
        <div class={styles.providerNote}>
          <p>
            A local endpoint: it authenticates nobody, so the credential below is optional. Give it
            an address this router can reach — inside a container <code>localhost</code> is the
            router itself, not the machine you are sitting at.
          </p>
        </div>
      </Show>

      <Show when={providerCredentialNote(props.provider?.id ?? "")}>
        {(note) => (
          <div class={styles.providerNote}>
            <p>{note()}</p>
          </div>
        )}
      </Show>
    </>
  )
}
