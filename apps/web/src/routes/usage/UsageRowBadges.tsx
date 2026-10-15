import { Show } from "solid-js"
import { Badge } from "../../components/Badge"
import type { UsageBreakdownRow } from "../../lib/api/usage"
import styles from "./UsageRowBadges.module.scss"

/**
 * What qualifies a row's name, beside the name.
 *
 * - **Owner kind.** A person and a service can share a slug, and the server keeps them as two
 *   rows; the kind is the only thing on screen that tells them apart. A key that names no kind
 *   reads `unknown`, in the warning tone, so it never passes for a person.
 * - **Retired.** A key that survives only as a tombstone still carries spend, and "retired" says
 *   why it is not in the keys list.
 *
 * Neither is colour alone: both are words.
 */
export function UsageRowBadges(props: { readonly row: UsageBreakdownRow }) {
  return (
    <Show when={props.row.ownerKind !== undefined || props.row.retired === true}>
      <span class={styles.badges}>
        <Show when={props.row.ownerKind}>
          {(kind) => (
            <Badge
              title={
                kind() === "unknown"
                  ? "This owner's key names no kind, so it is neither a person nor a service."
                  : undefined
              }
              tone={kind() === "unknown" ? "warn" : "neutral"}
            >
              {kind()}
            </Badge>
          )}
        </Show>
        <Show when={props.row.retired === true}>
          <Badge title="The key was deleted or purged; only its name and spend remain." tone="warn">
            retired
          </Badge>
        </Show>
      </span>
    </Show>
  )
}
