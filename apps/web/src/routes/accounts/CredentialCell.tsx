import { Show } from "solid-js"
import { Badge } from "../../components/Badge"
import { Button } from "../../components/Button"
import type { AccountView, ProviderDescriptor } from "../../lib/api/types"
import { cx } from "../../lib/cx"
import { formatAbsolute } from "../../lib/reset-countdown"
import {
  credentialOf,
  describeLoginExpiry,
  isSubscriptionLogin,
  subscriptionBadge,
} from "../../lib/subscription-login"
import { credentialHint, credentialLabel, credentialTone } from "./account-cells"
import styles from "./CredentialCell.module.scss"

export interface CredentialCellProps {
  readonly account: AccountView
  readonly provider: ProviderDescriptor | undefined
  readonly nowMs: number
  /** Opens the reconnect flow for this row. Rendered inline the moment a login is gone. */
  readonly onReconnect: (account: AccountView) => void
}

/**
 * The credential column, in two shapes.
 *
 * An API-key account gets the one-word pill it always had — stored, missing, not needed. A Claude
 * subscription gets the facts that actually decide whether it will serve tomorrow: the plan
 * ("Max 20×"), and **when the login dies** — absolute local time *and* countdown, the pair every
 * deadline in this console is stated as, with the tone turning at seven and two days out. Six
 * subscriptions expired on one morning while the console showed six green dots; this cell is the
 * week of warning that morning did not have.
 *
 * Once the login is gone the countdown goes with it — "Login expired — reconnect" and the button,
 * never "in 0s". The reconnect is the same row's same action as in the actions column; it is
 * repeated here because the operator's eye is on the reason, not three columns to the right.
 */
export function CredentialCell(props: CredentialCellProps) {
  const login = () => describeLoginExpiry(props.account, props.nowMs)
  const badge = () => subscriptionBadge(credentialOf(props.account))

  return (
    <Show
      fallback={
        <Badge
          tone={credentialTone(props.account, props.provider)}
          title={credentialHint(props.account, props.provider)}
        >
          {credentialLabel(props.account, props.provider)}
        </Badge>
      }
      when={isSubscriptionLogin(props.account)}
    >
      <div class={styles.root}>
        <div class={styles.badges}>
          <Show
            fallback={
              <Badge
                title={`Agent SDK config directory: ${props.account.configDir ?? "provisioned by the router"}`}
                tone="accent"
              >
                subscription
              </Badge>
            }
            when={badge()}
          >
            {(plan) => (
              <Badge
                title={`Plan and rate-limit tier as the subscription reports them. Agent SDK config directory: ${props.account.configDir ?? "provisioned by the router"}`}
                tone="accent"
              >
                {plan()}
              </Badge>
            )}
          </Show>
        </div>

        <Show
          fallback={
            <div class={styles.expired}>
              <span class={cx(styles.line, styles.danger)}>{login().text}</span>
              <Button onClick={() => props.onReconnect(props.account)} size="sm" tone="primary">
                Reconnect
              </Button>
            </div>
          }
          when={login().kind !== "expired"}
        >
          <Show
            fallback={<span class={cx(styles.line, styles.muted)}>{login().text}</span>}
            when={login().expiresAtMs}
          >
            {(expiresAt) => (
              <span
                class={cx(styles.line, styles[login().tone])}
                title={
                  login().source === "estimated"
                    ? "Estimated: the CLI did not report when this login (its ~4-week refresh token) dies, so the router counts from the last interactive login. Reconnecting resets it. The router never reads the token."
                    : "Reported by the claude CLI: when this login (its ~4-week refresh token) dies and a browser login is due again. The router never reads the token."
                }
              >
                {login().text}
                <span class={styles.countdown}> · {formatAbsolute(expiresAt())}</span>
              </span>
            )}
          </Show>
        </Show>
      </div>
    </Show>
  )
}
