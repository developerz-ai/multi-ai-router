import { Button } from "../../components/Button"
import { CopyValue } from "../../components/CopyValue"
import { Modal } from "../../components/Modal"
import { KeyConnectSnippets } from "./KeyConnectSnippets"
import styles from "./KeyValueDialog.module.scss"

export interface KeyValueDialogProps {
  readonly open: boolean
  readonly name: string
  readonly value: string
  /** True when this is the mint rather than a later reveal. Wording only. */
  readonly minted: boolean
  /** The router's own address, for the per-client snippets below the value. */
  readonly baseUrl: string
  readonly onClose: () => void
}

/**
 * A router key's value, shown in full.
 *
 * **There is no "you will not see this again" here, and there must never be.**
 * Keys are stored encrypted, not hashed; `POST /keys/:id/reveal` decrypts and
 * returns the value to an authenticated admin session at any time, and each
 * reveal is audited. A shown-once warning would be false, and would push
 * operators into keeping their own copies somewhere less safe than the router.
 *
 * The per-client snippets sit under the value rather than on a page of their own
 * because this is the one moment the operator has the key in front of them and a
 * client waiting for it — sending them to a docs tab to find out that Cursor
 * needs the `/v1` suffix is how the suffix gets left off.
 */
export function KeyValueDialog(props: KeyValueDialogProps) {
  return (
    <Modal
      description={
        props.minted
          ? "The key is live from this moment. Copy it into the client that will present it."
          : "Decrypted for this session. The reveal is recorded in the audit log."
      }
      footer={
        <Button onClick={() => props.onClose()} tone="primary">
          Done
        </Button>
      }
      onClose={() => props.onClose()}
      open={props.open}
      title={props.minted ? `Minted "${props.name}"` : `Key "${props.name}"`}
    >
      <CopyValue label={`Value of router key ${props.name}`} value={props.value} />
      <p class={styles.note}>
        You can come back and read this value whenever you need it — keys are encrypted at rest and
        retrievable by design. Nothing here is shown once.
      </p>
      <KeyConnectSnippets baseUrl={props.baseUrl} keyName={props.name} keyValue={props.value} />
    </Modal>
  )
}
