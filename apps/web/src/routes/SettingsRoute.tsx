import { Show } from "solid-js"
import { Badge } from "../components/Badge"
import { PageHeader } from "../components/PageHeader"
import { QueryBoundary } from "../components/QueryBoundary"
import { type Column, Table } from "../components/Table"
import { TableSkeleton } from "../components/TableSkeleton"
import type { ProviderDescriptor } from "../lib/api/types"
import { formatTimestamp } from "../lib/format"
import { useProviders } from "../lib/queries/providers"
import { useSession } from "../lib/queries/session"
import styles from "./SettingsRoute.module.scss"
import { AuditLogSection } from "./settings/AuditLogSection"
import { PriceOverridesSection } from "./settings/PriceOverridesSection"
import { RetentionSection } from "./settings/RetentionSection"
import { TaskHealthSection } from "./settings/TaskHealthSection"

/**
 * What the operator can see and tune about the router itself.
 *
 * Six sections, ordered by how often an operator comes here for them: the
 * session and the provider registry are read-only facts about this process;
 * prices are the one thing on this screen that is editable; retention, task
 * health and the audit log answer "what is the router doing on its own".
 *
 * Each section owns its query and its own loading and empty states, so a
 * failing audit read never blanks the price table beside it. This file is
 * layout and nothing else.
 */
export default function SettingsRoute() {
  const session = useSession()
  const providers = useProviders()

  const columns: readonly Column<ProviderDescriptor>[] = [
    { id: "id", header: "Provider", cell: (provider) => provider.id },
    {
      id: "transport",
      header: "Transport",
      cell: (provider) => (
        <Badge tone={provider.transport === "unimplemented" ? "warn" : "accent"}>
          {provider.transport}
        </Badge>
      ),
    },
    {
      id: "auth",
      header: "Auth",
      cell: (provider) => provider.authKind ?? "—",
    },
    {
      id: "dialects",
      header: "Dialects",
      cell: (provider) =>
        provider.supportedDialects.length === 0 ? "—" : provider.supportedDialects.join(", "),
    },
    {
      id: "requires",
      header: "Operator supplies",
      cell: (provider) => requirements(provider),
    },
    {
      id: "reason",
      header: "Notes",
      cell: (provider) => <span class={styles.note}>{provider.reason ?? "—"}</span>,
    },
  ]

  return (
    <>
      <PageHeader
        subtitle="Session, providers, pricing, retention, scheduler health, and audit trail."
        title="Settings"
      />

      <section aria-labelledby="session-heading" class={styles.panel}>
        <h2 class={styles.heading} id="session-heading">
          Session
        </h2>
        <Show fallback={<p class={styles.note}>Not signed in.</p>} when={session.isSuccess}>
          <dl class={styles.facts}>
            <div class={styles.fact}>
              <dt class={styles.term}>Signed in as</dt>
              <dd class={styles.value}>{session.data?.username}</dd>
            </div>
            <div class={styles.fact}>
              <dt class={styles.term}>Issued</dt>
              <dd class={styles.value}>{formatTimestamp(session.data?.issuedAt ?? null)}</dd>
            </div>
            <div class={styles.fact}>
              <dt class={styles.term}>Expires</dt>
              <dd class={styles.value}>{formatTimestamp(session.data?.expiresAt ?? null)}</dd>
            </div>
          </dl>
        </Show>
        <p class={styles.note}>
          One admin, no user table. The session lives server-side; the CSRF token is held in memory
          by this tab only and never written to storage.
        </p>
      </section>

      <section aria-labelledby="providers-heading" class={styles.section}>
        <h2 class={styles.heading} id="providers-heading">
          Provider registry
        </h2>
        <QueryBoundary
          errorTitle="The provider registry could not be loaded"
          loading={<TableSkeleton label="Loading providers" rows={4} />}
          query={providers}
        >
          {(rows) => (
            <Table
              caption="Providers are defined in code, not in a table — adding one is a single file under apps/api/src/providers/."
              columns={columns}
              rowId={(provider) => provider.id}
              rows={rows}
            />
          )}
        </QueryBoundary>
      </section>

      <PriceOverridesSection />
      <RetentionSection />
      <TaskHealthSection />
      <AuditLogSection />
    </>
  )
}

function requirements(provider: ProviderDescriptor): string {
  const parts: string[] = []
  if (provider.requiresBaseUrl) parts.push("base URL")
  if (provider.requiresConfigDir) parts.push("config directory")
  return parts.length === 0 ? "credential" : parts.join(" + ")
}
