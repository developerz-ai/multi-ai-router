import { createMemo, createUniqueId, For, Index, Show } from "solid-js"
import { QuotaWindowRow } from "../../components/QuotaWindowRow"
import { StatusDot } from "../../components/StatusDot"
import type { AccountView } from "../../lib/api/types"
import { formatRelative } from "../../lib/format"
import { describeQuotaWindows } from "../../lib/quota-windows"
import styles from "./UsageQuota.module.scss"

export interface UsageQuotaProps {
  readonly accounts: readonly AccountView[]
  readonly nowMs: number
  /** True when the accounts read failed. The section says so rather than quietly vanishing. */
  readonly failed: boolean
}

/**
 * How much of each subscription is left, per window.
 *
 * Spend and quota are **different questions with different units**, which is why this sits beside
 * the cost figures rather than among them. A flat-fee subscription has a notional cost that never
 * moves the invoice; what actually runs out is its five-hour window. An operator reading "$0.00
 * spent" on a Claude account and concluding it is idle is exactly the mistake this section exists
 * to prevent.
 *
 * Only accounts the router has readings for appear. An API key has one bill and no windows, and a
 * row of empty gauges for it would say the readings failed rather than that there are none — which
 * is also why a *failed read* is stated outright instead of leaving an empty screen that looks
 * like "no quota anywhere".
 *
 * The rows are `QuotaWindowRow`, the same component the accounts table uses. Two hand-written
 * copies of a quota row drifted on the reset instant and the `spent` marker before it was shared.
 */
export function UsageQuota(props: UsageQuotaProps) {
  const headingId = createUniqueId()

  const metered = createMemo(() =>
    props.accounts
      .map((account) => ({
        account,
        windows: describeQuotaWindows(
          { status: account.status, windows: account.availability?.quotaWindows ?? [] },
          props.nowMs,
        ),
      }))
      .filter((entry) => entry.windows.length > 0),
  )

  return (
    <Show when={props.failed || metered().length > 0}>
      <section aria-labelledby={headingId} class={styles.root}>
        <div class={styles.heading}>
          <h2 class={styles.title} id={headingId}>
            Quota
          </h2>
          <p class={styles.subtitle}>
            What runs out, per window. Not money — a subscription's spend is notional and its
            windows are the real limit.
          </p>
        </div>

        <Show when={props.failed}>
          <p class={styles.failed} role="alert">
            Accounts could not be loaded, so no quota is shown here. This is a failed read, not an
            absence of quota.
          </p>
        </Show>

        <ul class={styles.accounts}>
          <For each={metered()}>
            {(entry) => (
              <li class={styles.account}>
                <div class={styles.identity}>
                  <StatusDot status={entry.account.status} />
                  <span class={styles.label}>{entry.account.label}</span>
                  <span class={styles.provider}>{entry.account.provider}</span>
                </div>

                {/* `Index`, not `For`: these descriptions are rebuilt on every clock tick, so
                    keying by reference would dispose and recreate every gauge underneath. */}
                <ul class={styles.windows}>
                  <Index each={entry.windows}>
                    {(window) => <QuotaWindowRow owner={entry.account.label} window={window()} />}
                  </Index>
                </ul>

                <p class={styles.checked}>
                  Last reading {formatRelative(lastChecked(entry.windows), props.nowMs)}
                </p>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  )
}

/**
 * The freshest reading across the account's windows, as an ISO string. Stated because a gauge from
 * an hour ago and one from a second ago look identical, and only one of them is worth acting on.
 */
function lastChecked(
  windows: readonly { readonly lastCheckedAtMs: number | null }[],
): string | null {
  const instants = windows
    .map((window) => window.lastCheckedAtMs)
    .filter((instant): instant is number => instant !== null)

  return instants.length === 0 ? null : new Date(Math.max(...instants)).toISOString()
}
