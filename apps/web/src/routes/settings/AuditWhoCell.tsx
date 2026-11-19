import { type AuditEvent, auditWho } from "../../lib/api/audit"
import styles from "./AuditLogSection.module.scss"

/**
 * The audit log's "Who" cell (multi-ai-router#456): what the caller called itself, else its
 * credential's name, else "not recorded" for a row written before callers were recorded. A long name
 * is cut by the cell, never by the data — the tooltip holds it whole, with what verifies it.
 */
export function AuditWhoCell(props: { readonly event: AuditEvent }) {
  const who = () => auditWho(props.event)
  return (
    <span class={who().label === null ? styles.sub : styles.who} title={who().tooltip}>
      {who().label ?? "not recorded"}
    </span>
  )
}
