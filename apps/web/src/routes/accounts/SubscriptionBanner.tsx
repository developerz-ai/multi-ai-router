import { type Accessor, createMemo, For, type JSX, Show } from "solid-js"
import { Banner } from "../../components/Banner"
import type { AccountView } from "../../lib/api/types"
import { formatAbsolute } from "../../lib/format"
import {
  describeLoginExpiry,
  listNames,
  NAMED_LIMIT,
  type SubscriptionHealth,
  subscriptionBannerTitle,
  summarizeSubscriptions,
} from "../../lib/subscription-login"
import styles from "./SubscriptionBanner.module.scss"

export interface SubscriptionBannerProps {
  readonly accounts: readonly AccountView[]
  readonly nowMs: number
  /** One action: "Reconnect all (N)" on the accounts page, a link to it on the overview. */
  readonly action?: (health: Accessor<SubscriptionHealth>) => JSX.Element
}

/**
 * The week of warning the fleet did not have.
 *
 * Raised on the overview and the accounts page whenever a Claude subscription's login is gone or
 * inside the warn threshold. Danger when at least one needs a reconnect now — those accounts are
 * failing requests — and warn when every one still works but the clock is running. It names the
 * accounts and, for the ones still valid, when: the operator's plan for six browser logins starts
 * from the soonest.
 *
 * `exhausted` is not this banner's business and never appears here; the dashboard's red banner
 * keeps that one, and it says "needs top-up", never a countdown.
 */
export function SubscriptionBanner(props: SubscriptionBannerProps) {
  // The clock ticks every second and the verdict does not. Held until it changes, and handed to
  // the action as an accessor, so the reconnect button is never rebuilt under a press or a focus.
  const health = createMemo(() => summarizeSubscriptions(props.accounts, props.nowMs), undefined, {
    equals: sameHealth,
  })
  const title = () => subscriptionBannerTitle(health())

  return (
    <Show when={title()}>
      {(text) => (
        <Banner
          action={props.action?.(health)}
          title={text()}
          tone={health().needsReconnect.length > 0 ? "danger" : "warn"}
        >
          <Show when={health().needsReconnect.length > 0}>
            <p>
              Login expired — each needs one browser login:{" "}
              {listNames(health().needsReconnect.map((account) => account.label))}
            </p>
          </Show>
          <Show when={health().expiringSoon.length > 0}>
            <ul class={styles.list}>
              <For each={health().expiringSoon.slice(0, NAMED_LIMIT)}>
                {(account) => {
                  const login = createMemo(() => describeLoginExpiry(account, props.nowMs))
                  const expiresAtMs = () => login().expiresAtMs
                  return (
                    <li>
                      {account.label} — login valid until{" "}
                      {expiresAtMs() === null ? "unknown" : formatAbsolute(expiresAtMs() ?? 0)}
                      <Show when={login().countdown}>{(left) => <> · {left()}</>}</Show>
                    </li>
                  )
                }}
              </For>
              <Show when={health().expiringSoon.length > NAMED_LIMIT}>
                <li>
                  and {health().expiringSoon.length - NAMED_LIMIT} more — see the accounts page
                </li>
              </Show>
            </ul>
          </Show>
        </Banner>
      )}
    </Show>
  )
}

function sameHealth(a: SubscriptionHealth, b: SubscriptionHealth): boolean {
  const same = (one: readonly AccountView[], two: readonly AccountView[]) =>
    one.length === two.length && one.every((account, index) => account === two[index])
  return (
    a.warnDays === b.warnDays &&
    same(a.needsReconnect, b.needsReconnect) &&
    same(a.expiringSoon, b.expiringSoon)
  )
}
