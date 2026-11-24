import { Show } from "solid-js"
import { Badge } from "../../components/Badge"
import { Button } from "../../components/Button"
import type { ProxyCheck } from "../../lib/api/egress"
import { errorMessage, isApiError } from "../../lib/api/errors"
import { formatMillis, formatRelative } from "../../lib/format"
import { formatDuration } from "../../lib/reset-countdown"
import styles from "./egress.module.scss"
import { outcomeBadge } from "./egress-copy"

/** Refused as too soon. Any other failure, a retry deadline on it or not, is shown as it was said. */
const TEST_COOLDOWN = "proxy_test_cooldown"

/**
 * A press and its answer. The probe opens a tunnel and closes it; no request reaches an AI vendor.
 * Each one goes through somebody's paid proxy, so the router allows one per proxy per cooldown: the
 * wait is counted down here and the button held until it is over.
 */
export function ProxyTest(props: {
  readonly label: string
  readonly nowMs: number
  readonly busy: boolean
  readonly disabled?: boolean
  readonly result: ProxyCheck | undefined
  readonly error: unknown
  readonly onTest: () => void
}) {
  /** When the router refused a test as too soon: the instant it will take one. */
  const refusedUntil = () =>
    isApiError(props.error) && props.error.code === TEST_COOLDOWN ? props.error.retryAtMs : null
  const waitMs = () => {
    const next = Math.max(refusedUntil() ?? 0, Date.parse(props.result?.nextAllowedAt ?? "") || 0)
    return Math.max(0, next - props.nowMs)
  }

  return (
    <div class={styles.stack}>
      <span>
        <Button
          aria-label={props.label}
          busy={props.busy}
          disabled={props.disabled === true || waitMs() > 0}
          onClick={() => props.onTest()}
          size="sm"
          tone="neutral"
        >
          Test now
        </Button>
      </span>
      {/* Pre-mounted live region: one inserted together with its text announces unreliably. */}
      <span class={styles.stack} role="status">
        <Show when={props.result}>
          {(check) => (
            <>
              <span>
                <Badge
                  title={outcomeBadge(check().outcome).hint}
                  tone={outcomeBadge(check().outcome).tone}
                >
                  {outcomeBadge(check().outcome).label}
                </Badge>
              </span>
              <span class={styles.sub}>
                {formatMillis(check().latencyMs)} · {formatRelative(check().checkedAt, props.nowMs)}
              </span>
            </>
          )}
        </Show>
        <Show when={props.error !== null && props.error !== undefined && refusedUntil() === null}>
          <span class={styles.warn}>{errorMessage(props.error)}</span>
        </Show>
      </span>
      {/* Outside the live region: a countdown announced every tick says nothing new. */}
      <Show when={waitMs() > 0}>
        <span class={styles.sub}>
          {refusedUntil() === null ? "" : "Tested moments ago. "}
          {refusedUntil() === null ? "next test in " : "Next test in "}
          {formatDuration(waitMs())}
        </span>
      </Show>
    </div>
  )
}
