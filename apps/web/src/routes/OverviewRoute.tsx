import type { AccountStatus } from "@multi-ai-router/core"
import { For } from "solid-js"
import { PageHeader } from "../components/PageHeader"
import { Placeholder } from "../components/Placeholder"
import { StatTile } from "../components/StatTile"
import { StatusDot } from "../components/StatusDot"
import { type Column, Table } from "../components/Table"
import { isRoutable, STATUS_DISPLAY_ORDER, statusPresentation } from "../lib/account-status"
import styles from "./OverviewRoute.module.scss"

// Reference data, not fetched data: this is the status vocabulary itself, which
// is why it can be rendered before any API exists.
const STATUS_COLUMNS: readonly Column<AccountStatus>[] = [
  { id: "status", header: "Status", cell: (status) => <StatusDot status={status} /> },
  { id: "routable", header: "Routable", cell: (status) => (isRoutable(status) ? "yes" : "no") },
  { id: "meaning", header: "Meaning", cell: (status) => statusPresentation(status).hint },
]

// The headline figures, in the order the operator asks for them. No values yet:
// each tile renders its own loading state until the admin API lands, which is
// the state this console will genuinely be in on a cold start anyway.
const HEADLINE_TILES = [
  { label: "Requests today", note: "Client-facing, UTC day" },
  { label: "Upstream attempts", note: "Counted separately from requests" },
  { label: "Metered spend", note: "Notional shown apart" },
  { label: "Error rate", note: "Non-success share" },
] as const

export default function OverviewRoute() {
  return (
    <>
      <PageHeader
        subtitle="Fleet health at a glance: exhausted accounts, degraded pools, today's traffic."
        title="Overview"
      />

      <section aria-label="Headline figures" class={styles.tiles}>
        <For each={HEADLINE_TILES}>
          {(tile) => <StatTile label={tile.label} note={tile.note} />}
        </For>
      </section>

      <Placeholder
        icon="overview"
        items={[
          "Red banner listing every exhausted account — top-up needed, no countdown",
          "Accounts by status, with cooling_down and exhausted counted separately",
          "Today's requests, attempts, tokens and spend, metered and notional apart",
          "Router overhead beside upstream latency, so a slow provider is not read as a slow router",
          "Scheduled task health — a task that stopped running is called out, not inferred",
        ]}
        summary="The dashboard the operator lands on after login. The tiles above are showing their loading state — they fill in when the admin API lands."
      />

      <Table
        caption="Account status vocabulary — reference, not live data."
        columns={STATUS_COLUMNS}
        rowId={(status) => status}
        rows={STATUS_DISPLAY_ORDER}
      />
    </>
  )
}
