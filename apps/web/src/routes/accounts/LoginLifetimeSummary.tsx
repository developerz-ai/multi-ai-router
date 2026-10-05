import { Show } from "solid-js"
import type { AccountView } from "../../lib/api/types"
import { cx } from "../../lib/cx"
import { formatAbsolute } from "../../lib/reset-countdown"
import {
  credentialOf,
  describeLoginExpiry,
  isSubscriptionLogin,
} from "../../lib/subscription-login"
import styles from "./LoginLifetimeSummary.module.scss"

export interface LoginLifetimeSummaryProps {
  readonly account: AccountView | null
  readonly nowMs: number
}

/**
 * A Claude subscription's two credential clocks, spelled out for the account's own dialog: when the
 * *login* is due again (and whether that instant was reported by the CLI or estimated from the last
 * interactive login), when that login happened, and when the CLI's short-lived access token next
 * refreshes. Timestamps the API relayed — the router never reads the token itself.
 *
 * Renders nothing for any other provider.
 */
export function LoginLifetimeSummary(props: LoginLifetimeSummaryProps) {
  const subscription = () =>
    props.account !== null && isSubscriptionLogin(props.account) ? props.account : null

  return (
    <Show when={subscription()}>
      {(account) => {
        const login = () => describeLoginExpiry(account(), props.nowMs)
        const credential = () => credentialOf(account())
        const instant = (iso: string | null | undefined) =>
          iso === null || iso === undefined ? "unknown" : formatAbsolute(Date.parse(iso))
        return (
          <dl class={styles.root}>
            <dt>Login</dt>
            <dd class={cx(styles[login().tone])}>
              {login().text}
              <Show when={login().expiresAtMs}>
                {(at) => <span class={styles.instant}> · {formatAbsolute(at())}</span>}
              </Show>
            </dd>
            <dt>Last interactive login</dt>
            <dd>{instant(credential()?.lastLoginAt)}</dd>
            <dt>Access token refreshes</dt>
            <dd>{instant(credential()?.accessTokenExpiresAt)}</dd>
          </dl>
        )
      }}
    </Show>
  )
}
