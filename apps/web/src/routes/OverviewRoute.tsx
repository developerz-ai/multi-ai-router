import type { AccountStatus } from "@multi-ai-router/core"
import { A } from "@solidjs/router"
import { createMemo, Show } from "solid-js"
import { Banner } from "../components/Banner"
import { Button } from "../components/Button"
import { PageHeader } from "../components/PageHeader"
import { QueryBoundary } from "../components/QueryBoundary"
import { StatTile } from "../components/StatTile"
import { StatusDot } from "../components/StatusDot"
import { type Column, Table } from "../components/Table"
import { TableSkeleton } from "../components/TableSkeleton"
import { isRoutable, STATUS_DISPLAY_ORDER, statusPresentation } from "../lib/account-status"
import type { AccountView } from "../lib/api/types"
import { usageWindowLabel } from "../lib/api/usage"
import { formatCost, formatCount, formatPercent } from "../lib/format"
import { useAllAccounts, useRecheckAllAccounts } from "../lib/queries/accounts"
import { usePools } from "../lib/queries/pools"
import { useKeys } from "../lib/queries/router-keys"
import { useUsageSummary } from "../lib/queries/usage"
import styles from "./OverviewRoute.module.scss"

interface StatusCount {
  readonly status: AccountStatus
  readonly count: number
}

/**
 * The dashboard the operator lands on after login.
 *
 * The one thing this screen exists to do is put **`exhausted` accounts in a red
 * banner rather than in a status pill three screens deep**. An exhausted account
 * is not waiting on a clock; it is waiting on a human with a credit card, and
 * nothing else on the console will tell them that in time.
 *
 * `needs_reauth` shares the banner for the same reason — it is the other status
 * no amount of waiting fixes. They are still named separately inside it, because
 * one needs money and the other needs a re-login.
 */
export default function OverviewRoute() {
  const accounts = useAllAccounts()
  const pools = usePools()
  const keys = useKeys()
  const usage = useUsageSummary(() => "today")
  const recheckAll = useRecheckAllAccounts()

  const list = () => (accounts.isSuccess ? (accounts.data ?? []) : [])
  const exhausted = createMemo(() => list().filter((account) => account.status === "exhausted"))
  const needsReauth = createMemo(() =>
    list().filter((account) => account.status === "needs_reauth"),
  )

  const counts = createMemo<readonly StatusCount[]>(() =>
    STATUS_DISPLAY_ORDER.map((status) => ({
      status,
      count: list().filter((account) => account.status === status).length,
    })),
  )

  const columns: readonly Column<StatusCount>[] = [
    { id: "status", header: "Status", cell: (row) => <StatusDot status={row.status} /> },
    { id: "count", header: "Accounts", numeric: true, cell: (row) => String(row.count) },
    {
      id: "routable",
      header: "Routable",
      cell: (row) => (isRoutable(row.status) ? "yes" : "no"),
    },
    { id: "meaning", header: "Meaning", cell: (row) => statusPresentation(row.status).hint },
  ]

  return (
    <>
      <PageHeader
        actions={
          <Button busy={recheckAll.isPending} onClick={() => recheckAll.mutate()} tone="neutral">
            Re-check all
          </Button>
        }
        subtitle="Fleet health at a glance: exhausted accounts, degraded pools, today's traffic."
        title="Overview"
      />

      <Show when={exhausted().length > 0 || needsReauth().length > 0}>
        <Banner
          action={
            <A class={styles.bannerLink} href="/accounts">
              Open accounts
            </A>
          }
          title={bannerTitle(exhausted().length, needsReauth().length)}
          tone="danger"
        >
          <Show when={exhausted().length > 0}>
            <p>Out of credits, no reset to wait for — needs top-up: {names(exhausted())}</p>
          </Show>
          <Show when={needsReauth().length > 0}>
            <p>Credentials can no longer be renewed — reconnect: {names(needsReauth())}</p>
          </Show>
        </Banner>
      </Show>

      <section aria-label="Headline figures" class={styles.tiles}>
        <StatTile
          label="Accounts"
          note={`${list().filter((account) => isRoutable(account.status)).length} routable now`}
          value={accounts.isSuccess ? String(list().length) : undefined}
        />
        <StatTile
          label="Pools"
          note="Each one addressable by a key"
          value={pools.isSuccess ? String((pools.data ?? []).length) : undefined}
        />
        <StatTile
          label="Router keys"
          note={`${keys.isSuccess ? (keys.data ?? []).filter((key) => !key.revoked).length : 0} active`}
          value={keys.isSuccess ? String((keys.data ?? []).length) : undefined}
        />
        <StatTile
          label="Requests today"
          note="Placeholder — no usage API yet"
          value={usage.isSuccess ? formatCount(usage.data?.totals.requests ?? 0) : undefined}
        />
        <StatTile
          label="Metered spend"
          note="Placeholder — notional shown apart"
          value={usage.isSuccess ? formatCost(usage.data?.totals.costMetered ?? 0) : undefined}
        />
        <StatTile
          label="Error rate"
          note={`Placeholder · ${usageWindowLabel("today").toLowerCase()}`}
          value={
            usage.isSuccess
              ? formatPercent(usage.data?.totals.errors ?? 0, usage.data?.totals.attempts ?? 0)
              : undefined
          }
        />
      </section>

      <QueryBoundary
        errorTitle="Fleet status could not be loaded"
        loading={<TableSkeleton label="Loading fleet status" rows={5} />}
        query={accounts}
      >
        {() => (
          <Table
            caption="Accounts by status. cooling_down and exhausted are counted separately — one is a clock, the other is a purchase."
            columns={columns}
            rowId={(row) => row.status}
            rows={counts()}
          />
        )}
      </QueryBoundary>
    </>
  )
}

function bannerTitle(exhausted: number, needsReauth: number): string {
  const parts: string[] = []
  if (exhausted > 0) parts.push(`${exhausted} account(s) exhausted`)
  if (needsReauth > 0) parts.push(`${needsReauth} need re-authentication`)
  return parts.join(" · ")
}

function names(accounts: readonly AccountView[]): string {
  return accounts.map((account) => account.label).join(", ")
}
