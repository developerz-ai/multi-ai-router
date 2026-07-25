import { createEffect, createSignal, For, Show } from "solid-js"
import { EmptyState } from "../../components/EmptyState"
import { SelectField } from "../../components/Field"
import { QueryBoundary } from "../../components/QueryBoundary"
import { type Column, Table } from "../../components/Table"
import { TableSkeleton } from "../../components/TableSkeleton"
import {
  AUDIT_LIMIT_DEFAULT,
  AUDIT_LIMITS,
  type AuditEvent,
  auditDetailEntries,
  auditKinds,
  auditSubjectText,
  mergeKinds,
} from "../../lib/api/audit"
import { createNow } from "../../lib/clock"
import { formatRelative, formatTimestamp } from "../../lib/format"
import { useAuditLog } from "../../lib/queries/settings"
import styles from "./AuditLogSection.module.scss"

/**
 * Admin-plane mutations, newest first.
 *
 * Two properties are worth stating rather than assuming. The log is
 * **append-only** — nothing but the janitor's retention sweep ever removes a row
 * — and it **never contains credential material**: a key view is recorded as
 * `key.viewed` with an id, never with a value (docs/idea/08-observability.md).
 *
 * The kind filter is built from the kinds actually seen rather than a hard-coded
 * list, so a kind added on the API side appears here without a console release.
 * Kinds seen earlier are kept, because a page already narrowed to one kind cannot
 * enumerate the ones to switch to.
 */
export function AuditLogSection() {
  const [limit, setLimit] = createSignal<number>(AUDIT_LIMIT_DEFAULT)
  const [kind, setKind] = createSignal<string | null>(null)
  const [seenKinds, setSeenKinds] = createSignal<readonly string[]>([])
  const now = createNow(30_000)

  const events = useAuditLog(() => ({ limit: limit(), kind: kind(), subjectId: null }))

  // `isSuccess` is read before `data` for the reason `QueryBoundary` documents:
  // the data is resource-backed, and reading it while pending suspends.
  createEffect(() => {
    if (!events.isSuccess) return
    const page = events.data
    if (page === undefined) return
    setSeenKinds((current) => {
      const merged = mergeKinds(current, auditKinds(page.events))
      return merged.length === current.length ? current : merged
    })
  })

  const columns = (): readonly Column<AuditEvent>[] => [
    {
      id: "when",
      header: "When",
      cell: (event) => (
        <div class={styles.stack}>
          <span>{formatTimestamp(event.createdAt)}</span>
          <span class={styles.sub}>{formatRelative(event.createdAt, now())}</span>
        </div>
      ),
    },
    {
      id: "kind",
      header: "Kind",
      cell: (event) => <span class={styles.kind}>{event.kind}</span>,
    },
    {
      id: "subject",
      header: "Subject",
      cell: (event) => (
        <Show fallback={<span class={styles.sub}>—</span>} when={event.subjectId}>
          {(id) => (
            <div class={styles.stack}>
              <span class={styles.sub}>{event.subjectType ?? "unknown"}</span>
              {/* Not always a uuid: a settings change names `price_overrides`,
                  a login names the admin. Only a uuid is shortened. */}
              <span class={styles.id} title={id()}>
                {auditSubjectText(id())}
              </span>
            </div>
          )}
        </Show>
      ),
    },
    {
      id: "detail",
      header: "Detail",
      cell: (event) => (
        <Show fallback={<span class={styles.sub}>—</span>} when={detail(event).length > 0}>
          <ul class={styles.chips}>
            <For each={detail(event)}>
              {(entry) => (
                <li class={styles.chip} title={`${entry.key}=${entry.full}`}>
                  <span class={styles.chipKey}>{entry.key}</span>
                  <span class={styles.chipValue}>{entry.value}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      ),
    },
  ]

  return (
    <section aria-labelledby="audit-heading" class={styles.section}>
      <h2 class={styles.heading} id="audit-heading">
        Audit log
      </h2>

      <div class={styles.controls}>
        <fieldset class={styles.limits}>
          <legend class={styles.groupLabel}>Events shown</legend>
          <For each={AUDIT_LIMITS}>
            {(value) => (
              <button
                aria-pressed={limit() === value ? "true" : "false"}
                class={styles.limit}
                onClick={() => setLimit(value)}
                type="button"
              >
                {value}
              </button>
            )}
          </For>
        </fieldset>

        <SelectField
          hint="Built from the kinds this console has seen, not from a fixed list."
          label="Kind"
          onChange={(event) =>
            setKind(event.currentTarget.value === "" ? null : event.currentTarget.value)
          }
          options={[
            { value: "", label: "Any kind" },
            ...seenKinds().map((value) => ({ value, label: value })),
          ]}
          value={kind() ?? ""}
        />
      </div>

      <QueryBoundary
        errorTitle="The audit log could not be loaded"
        loading={<TableSkeleton label="Loading audit log" rows={5} />}
        query={events}
      >
        {(page) => (
          <Show
            fallback={
              <EmptyState
                description={
                  kind() === null
                    ? "Every admin-plane mutation lands here — accounts added, keys minted or viewed, pools re-policied, settings changed. Nothing has been recorded yet."
                    : "No event of that kind is in this page. Widen the window or clear the filter."
                }
                icon="settings"
                title={kind() === null ? "No admin activity yet" : "Nothing matches that kind"}
              />
            }
            when={page.events.length > 0}
          >
            <Table
              caption={`Newest first, at most ${page.limit} events. The log is append-only — only the janitor's retention sweep ever removes a row — and never contains credential material: a key view is recorded by id, never by value.`}
              columns={columns()}
              rowId={(event) => event.id}
              rows={page.events}
            />
          </Show>
        )}
      </QueryBoundary>
    </section>
  )
}

const detail = (event: AuditEvent) => auditDetailEntries(event.detail)
