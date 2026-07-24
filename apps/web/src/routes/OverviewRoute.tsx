import type { AccountStatus } from "@multi-ai-router/core"
import { PageHeader } from "../components/PageHeader"
import { Placeholder } from "../components/Placeholder"
import { StatusDot } from "../components/StatusDot"
import { type Column, Table } from "../components/Table"
import { isRoutable, STATUS_DISPLAY_ORDER, statusPresentation } from "../lib/account-status"

// Reference data, not fetched data: this is the status vocabulary itself, which
// is why it can be rendered before any API exists.
const STATUS_COLUMNS: readonly Column<AccountStatus>[] = [
  { id: "status", header: "Status", cell: (status) => <StatusDot status={status} /> },
  { id: "routable", header: "Routable", cell: (status) => (isRoutable(status) ? "yes" : "no") },
  { id: "meaning", header: "Meaning", cell: (status) => statusPresentation(status).hint },
]

export default function OverviewRoute() {
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Fleet health at a glance: exhausted accounts, degraded pools, today's traffic."
      />
      <Placeholder
        summary="The dashboard the operator lands on after login."
        items={[
          "Red banner listing every exhausted account — top-up needed, no countdown",
          "Accounts by status, with cooling_down and exhausted counted separately",
          "Today's requests, attempts, tokens and spend, metered and notional apart",
          "Router overhead beside upstream latency, so a slow provider is not read as a slow router",
          "Scheduled task health — a task that stopped running is called out, not inferred",
        ]}
      />
      <Table
        caption="Account status vocabulary — reference, not live data."
        columns={STATUS_COLUMNS}
        rows={STATUS_DISPLAY_ORDER}
        rowId={(status) => status}
      />
    </>
  )
}
