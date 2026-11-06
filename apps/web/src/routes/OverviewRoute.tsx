import type { AccountStatus } from "@multi-ai-router/core"
import { A } from "@solidjs/router"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Banner } from "../components/Banner"
import { Button } from "../components/Button"
import { PageHeader } from "../components/PageHeader"
import { QueryBoundary } from "../components/QueryBoundary"
import { StatusDot } from "../components/StatusDot"
import { type Column, Table } from "../components/Table"
import { TableSkeleton } from "../components/TableSkeleton"
import {
  hasSpentWindow,
  isCredentialRejected,
  isRoutable,
  isRoutableNow,
  STATUS_DISPLAY_ORDER,
  statusPresentation,
} from "../lib/account-status"
import { errorMessage } from "../lib/api/errors"
import type { AccountView } from "../lib/api/types"
import { USAGE_WINDOWS, type UsageWindow, usageWindowLabel } from "../lib/api/usage"
import { createNow } from "../lib/clock"
import { useAllAccounts, useRecheckAllAccounts } from "../lib/queries/accounts"
import { usePools } from "../lib/queries/pools"
import { useProviders } from "../lib/queries/providers"
import { useKeys } from "../lib/queries/router-keys"
import { useSettings } from "../lib/queries/settings"
import { useUsageSummary } from "../lib/queries/usage"
import { isSubscriptionLogin, listNames } from "../lib/subscription-login"
import { SubscriptionBanner } from "./accounts/SubscriptionBanner"
import styles from "./OverviewRoute.module.scss"
import { FleetTiles } from "./overview/FleetTiles"
import { OnboardingPanel } from "./overview/OnboardingPanel"

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
 * one needs money and the other needs a re-login. Claude subscriptions are the
 * exception: their re-login has a *deadline the router can see*, so they get
 * `SubscriptionBanner` — which warns a week before the login dies, not after.
 *
 * Before any of that, this is also the screen a brand new deployment lands on with nothing in it
 * — `OnboardingPanel` owns that walk end to end and decides its own visibility from the same
 * three queries this route already holds. The banner, tiles and status table are hidden while
 * there are zero accounts: a table of every status reading zero is noise under a "let's get you
 * set up" panel, not information.
 */
export default function OverviewRoute() {
  const accounts = useAllAccounts()
  const pools = usePools()
  const keys = useKeys()
  const providers = useProviders()
  const settings = useSettings()
  // Its own window, not a hardcoded "today": the same four named windows the Usage screen offers,
  // so the two can be pointed at the same range and reconciled — before this, Overview was pinned
  // to "today" with no control and the two screens could silently disagree.
  const [window, setWindow] = createSignal<UsageWindow>("today")
  const usage = useUsageSummary(window)
  const recheckAll = useRecheckAllAccounts()
  // Coarse: the subscription banner counts down in days, not seconds.
  const now = createNow(30_000)

  const list = () => (accounts.isSuccess ? (accounts.data ?? []) : [])
  const poolList = () => (pools.isSuccess ? (pools.data ?? []) : [])
  const keyList = () => (keys.isSuccess ? (keys.data ?? []) : [])
  const providerList = () => (providers.isSuccess ? (providers.data ?? []) : [])

  // One loading concept for both the onboarding panel and the fleet dashboard below it: gating
  // each on its own query would let the dashboard hide (accounts resolved, zero of them) while
  // the panel has not decided yet (pools/keys still in flight), leaving a blank gap between them.
  const loaded = createMemo(() => accounts.isSuccess && pools.isSuccess && keys.isSuccess)
  // The literal zero state this screen exists to catch — a fresh deployment with nothing in it
  // yet, where a table of every-status-zero and an all-zero tile row would be noise beneath the
  // guided panel rather than information.
  const zeroAccounts = createMemo(() => loaded() && list().length === 0)

  const exhausted = createMemo(() => list().filter((account) => account.status === "exhausted"))
  // Subscriptions are named by their own banner, with the deadline; this one keeps the rest.
  const needsReauth = createMemo(() =>
    list().filter((account) => account.status === "needs_reauth" && !isSubscriptionLogin(account)),
  )

  // A cooldown to routing, but a wrong key outlasts every re-test, so it asks for the operator.
  const rejected = createMemo(() => list().filter(isCredentialRejected))

  const counts = createMemo<readonly StatusCount[]>(() =>
    STATUS_DISPLAY_ORDER.map((status) => ({
      status,
      count: list().filter((account) => account.status === status).length,
    })),
  )

  // Active accounts a spent quota window is currently blocking. Server-computed `spent`, the same
  // verdict candidate filtering reaches — these are green dots that will 429, and both the
  // routable headline and the status table must say so rather than counting them as capacity.
  const windowBlocked = createMemo(
    () =>
      list().filter(
        (account) =>
          account.status === "active" && hasSpentWindow(account.availability?.quotaWindows),
      ).length,
  )
  const routableNow = createMemo(
    () =>
      list().filter((account) => isRoutableNow(account.status, account.availability?.quotaWindows))
        .length,
  )

  const columns = (): readonly Column<StatusCount>[] => [
    { id: "status", header: "Status", cell: (row) => <StatusDot status={row.status} /> },
    { id: "count", header: "Accounts", numeric: true, cell: (row) => String(row.count) },
    {
      id: "routable",
      header: "Routable",
      cell: (row) => {
        if (!isRoutable(row.status)) return "no"
        const blocked = windowBlocked()
        return blocked > 0 ? `yes — ${blocked} window-spent now` : "yes"
      },
    },
    { id: "meaning", header: "Meaning", cell: (row) => statusPresentation(row.status).hint },
  ]

  return (
    <>
      <PageHeader
        actions={
          <div class={styles.actions}>
            <fieldset class={styles.windows}>
              <legend class={styles.groupLabel}>Window</legend>
              <For each={USAGE_WINDOWS}>
                {(value) => (
                  <button
                    aria-pressed={window() === value ? "true" : "false"}
                    class={styles.window}
                    onClick={() => setWindow(value)}
                    type="button"
                  >
                    {usageWindowLabel(value)}
                  </button>
                )}
              </For>
            </fieldset>
            <Button busy={recheckAll.isPending} onClick={() => recheckAll.mutate()} tone="neutral">
              Re-check all
            </Button>
          </div>
        }
        subtitle="Fleet health at a glance: exhausted accounts, degraded pools, traffic for the chosen window."
        title="Overview"
      />

      <Show when={recheckAll.isError}>
        <Banner title="Re-check all failed" tone="danger">
          {errorMessage(recheckAll.error)}
        </Banner>
      </Show>

      <Show when={loaded()}>
        <OnboardingPanel
          accounts={list()}
          keys={keyList()}
          pools={poolList()}
          providers={providerList()}
          publicUrl={settings.data?.publicUrl ?? null}
        />
      </Show>

      <Show when={!zeroAccounts()}>
        <SubscriptionBanner
          accounts={list()}
          action={() => (
            <A class={styles.bannerLink} href="/accounts">
              Open accounts
            </A>
          )}
          nowMs={now()}
        />

        <Show when={exhausted().length + needsReauth().length + rejected().length > 0}>
          <Banner
            action={
              <A class={styles.bannerLink} href="/accounts">
                Open accounts
              </A>
            }
            title={bannerTitle(exhausted().length, needsReauth().length, rejected().length)}
            tone="danger"
          >
            <Show when={exhausted().length > 0}>
              <p>
                Out of credits, no reset to wait for — needs top-up, then press Re-check on its row:{" "}
                {names(exhausted())}
              </p>
            </Show>
            <Show when={needsReauth().length > 0}>
              <p>Credentials can no longer be renewed — reconnect: {names(needsReauth())}</p>
            </Show>
            <Show when={rejected().length > 0}>
              <p>The upstream refused the key — rotate it in Edit: {names(rejected())}</p>
            </Show>
          </Banner>
        </Show>

        <section aria-label="Headline figures" class={styles.tiles}>
          <FleetTiles
            accounts={accounts}
            keys={keys}
            pools={pools}
            routableNow={routableNow()}
            usage={usage}
            windowLabel={usageWindowLabel(window()).toLowerCase()}
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
              columns={columns()}
              rowId={(row) => row.status}
              rows={counts()}
            />
          )}
        </QueryBoundary>
      </Show>
    </>
  )
}

function bannerTitle(exhausted: number, needsReauth: number, rejected: number): string {
  const parts: string[] = []
  if (exhausted > 0) parts.push(`${exhausted} account${exhausted === 1 ? "" : "s"} exhausted`)
  if (needsReauth > 0) {
    parts.push(`${needsReauth} need${needsReauth === 1 ? "s" : ""} re-authentication`)
  }
  if (rejected > 0) parts.push(`${rejected} key${rejected === 1 ? "" : "s"} rejected`)
  return parts.join(" · ")
}

function names(accounts: readonly AccountView[]): string {
  return listNames(accounts.map((account) => account.label))
}
