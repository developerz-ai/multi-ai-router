import { createSignal, createUniqueId, type JSX, Show } from "solid-js"
import { Badge } from "../../components/Badge"
import { Button } from "../../components/Button"
import { Icon } from "../../components/Icon"
import { StatusDot } from "../../components/StatusDot"
import type { ProviderGroup as Group } from "../../lib/account-groups"
import type { AccountView } from "../../lib/api/types"
import { formatAbsolute, formatDuration } from "../../lib/reset-countdown"
import styles from "./ProviderGroup.module.scss"

export interface ProviderGroupProps {
  readonly group: Group
  /** Names of the pools any account in this group belongs to. Empty when none, or not loaded. */
  readonly pools: readonly string[]
  readonly nowMs: number
  readonly onReconnectAll: (accounts: readonly AccountView[]) => void
  readonly children: JSX.Element
}

/**
 * One provider's fleet: a header that answers the four questions an operator scans for — how many,
 * how many routable now, the worst status among them, and when the next subscription login dies —
 * over the dense table of its accounts.
 *
 * Collapsible so a healthy provider folds to one line and the one in trouble gets the screen. The
 * toggle is a real button (`aria-expanded`, keyboard-reachable) and the fold has no animation to
 * disable — it is display, not motion.
 */
export function ProviderGroup(props: ProviderGroupProps) {
  const [open, setOpen] = createSignal(true)
  const headingId = createUniqueId()
  const panelId = createUniqueId()

  const count = () => props.group.accounts.length
  const nextExpiry = () => props.group.nextLoginExpiryMs

  return (
    <section
      aria-labelledby={headingId}
      class={styles.root}
      data-attention={props.group.attention > 0}
    >
      <header class={styles.header}>
        <button
          aria-controls={panelId}
          aria-expanded={open() ? "true" : "false"}
          class={styles.toggle}
          onClick={() => setOpen(!open())}
          type="button"
        >
          <span aria-hidden="true" class={styles.chevron} data-open={open()}>
            <Icon name="chevron" />
          </span>
          <span class={styles.heading} id={headingId}>
            {props.group.name}
          </span>
          <span class={styles.providerId}>{props.group.provider}</span>
        </button>

        <div class={styles.summary}>
          <StatusDot status={props.group.worst} />
          <span class={styles.count}>
            {count()} account{count() === 1 ? "" : "s"} · {props.group.routable} routable
          </span>
          <Show when={props.group.attention > 0}>
            <Badge tone="danger">
              {props.group.attention} need{props.group.attention === 1 ? "s" : ""} attention
            </Badge>
          </Show>
          <Show when={props.pools.length > 0}>
            <span class={styles.pools} title="Pools any account in this group belongs to.">
              in {props.pools.join(", ")}
            </span>
          </Show>
          <Show when={nextExpiry()}>
            {(at) => (
              <span
                class={styles.expiry}
                title="The soonest subscription login to expire in this group. Reconnect before it does."
              >
                next login expiry {formatAbsolute(at())} · {formatDuration(at() - props.nowMs)}
              </span>
            )}
          </Show>
        </div>

        <Show when={props.group.reconnectable.length > 0}>
          <div class={styles.actions}>
            <Button
              onClick={() => props.onReconnectAll(props.group.reconnectable)}
              size="sm"
              tone="primary"
            >
              Reconnect all ({props.group.reconnectable.length})
            </Button>
          </div>
        </Show>
      </header>

      <div class={styles.panel} hidden={!open()} id={panelId}>
        {props.children}
      </div>
    </section>
  )
}
