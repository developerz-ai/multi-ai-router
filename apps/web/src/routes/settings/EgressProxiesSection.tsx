import { For, Show } from "solid-js"
import { Banner } from "../../components/Banner"
import { QueryBoundary } from "../../components/QueryBoundary"
import { TableSkeleton } from "../../components/TableSkeleton"
import type { EgressOverview, EgressVendorState } from "../../lib/api/egress"
import { createNow } from "../../lib/clock"
import { useEgressOverview } from "../../lib/queries/egress"
import { listNames } from "../../lib/subscription-login"
import { REPLACE_RULE, TEST_CLOCK_MS } from "../egress/egress-copy"
import { EgressAssignedTable } from "./EgressAssignedTable"
import { EgressInventoryTable } from "./EgressInventoryTable"
import styles from "./WeeklyReportSection.module.scss"

/** The fleet's proxies: which account leaves through which, how each is doing, and what is spare. */
export function EgressProxiesSection() {
  const overview = useEgressOverview()
  const now = createNow(TEST_CLOCK_MS)

  return (
    <section aria-labelledby="egress-heading" class={styles.section}>
      <h2 class={styles.heading} id="egress-heading">
        Egress proxies
      </h2>
      <p class={styles.note}>
        An account with a proxy sends every call through that one address and never goes around it.{" "}
        {REPLACE_RULE}
      </p>

      <QueryBoundary
        errorTitle="Egress proxies could not be loaded"
        loading={<TableSkeleton label="Loading egress proxies" rows={3} />}
        query={overview}
      >
        {(view) => (
          <>
            <Show when={stuck(view()).length > 0}>
              <Banner
                title={`${stuck(view()).length} dead prox${stuck(view()).length === 1 ? "y was" : "ies were"} not replaced`}
                tone="danger"
              >
                {listNames(stuck(view()).map((row) => row.account.label))} — the reason is on each
                row.
              </Banner>
            </Show>
            <For each={view().vendors}>
              {(vendor) => (
                <Show when={vendorNote(vendor)}>
                  {(note) => <p class={styles.note}>{note()}</p>}
                </Show>
              )}
            </For>
            <EgressAssignedTable nowMs={now()} overview={view()} />
            <Show when={view().proxies.length > 0}>
              <EgressInventoryTable nowMs={now()} proxies={view().proxies} />
            </Show>
          </>
        )}
      </QueryBoundary>
    </section>
  )
}

const stuck = (overview: EgressOverview) =>
  overview.assigned.filter(
    ({ health }) => health.repair === "no_candidate" || health.repair === "vendor_unavailable",
  )

function vendorNote(vendor: EgressVendorState): string | null {
  if (vendor.state === "off") {
    return `${vendor.vendor}: not configured on this router, so it lists nothing. A proxy URL can still be typed in per account.`
  }
  if (vendor.state === "unavailable") {
    const reason = vendor.error?.message ?? `${vendor.vendor} could not be read`
    return `${reason}, so its list is missing here and no proxy is replaced.`
  }
  return vendor.complete
    ? null
    : `${vendor.vendor}: its list is longer than the router reads, so a proxy missing here is not evidence and nothing is replaced.`
}
