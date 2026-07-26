import { Show } from "solid-js"
import { Badge } from "../../components/Badge"
import { type Column, Table } from "../../components/Table"
import {
  faultLabel,
  faultToken,
  outcomeLabel,
  type RecentAttempt,
  type RecentSubject,
} from "../../lib/api/usage-recent"
import { formatRelative, formatTimestamp, shortId } from "../../lib/format"
import styles from "./RecentAttemptsTable.module.scss"

/**
 * One upstream attempt per row — the table half of the live feed.
 *
 * Pure and prop-driven, like every other panel on this screen: the fetching, the filters and the
 * clock live in `UsageRecent`, so what an operator can actually read off a row is assertable
 * without a network or a timer.
 *
 * Four columns are pairs on purpose, and never a single figure:
 *
 * - **Status / error class.** `null` means the router never reached the upstream at all, which is
 *   a different fact from "it answered 500" and reads as "never reached", not as a blank.
 * - **Request id / attempt number.** A failover chain of three is three rows under one id. The
 *   caller's own `x-request-id` rides beside the router's, because an operator holding one of them
 *   has no way to know which.
 * - **Model asked for / model sent.** They differ only when an account's alias map rewrote it, and
 *   "asked for sonnet, sent glm-4.7" is the only thing that explains the bill.
 * - **Attempt latency / router overhead + first byte.** Latency is dominated by generation time;
 *   the other two are the figures the <5 ms and zero-added-TTFT budgets are read off. They do not
 *   share a start — latency runs from *this attempt*, TTFB from the request entering the router —
 *   so the cell's tooltip says so rather than letting a reader take one for a slice of the other.
 *
 * Colour is never the only carrier: the dot takes its token from whose problem the failure is
 * (`usageOutcomeFault`, resolved by the router and carried on the row), and the outcome is spelled out beside it either way.
 */

export interface RecentAttemptsTableProps {
  readonly attempts: readonly RecentAttempt[]
  /** Echoed in the caption so the table says how deep the page it is showing goes. */
  readonly limit: number
  /** Injected, never read from a clock here — that is what keeps this testable at a fixed time. */
  readonly nowMs: number
}

export function RecentAttemptsTable(props: RecentAttemptsTableProps) {
  const columns = (): readonly Column<RecentAttempt>[] => [
    {
      id: "when",
      header: "When",
      cell: (attempt) => (
        <div class={styles.stack}>
          <span class={styles.when}>{formatTimestamp(attempt.at)}</span>
          <span class={styles.sub}>{formatRelative(attempt.at, props.nowMs)}</span>
        </div>
      ),
    },
    {
      id: "outcome",
      header: "Outcome",
      cell: (attempt) => (
        <div class={styles.outcome}>
          {/* Decorative: the outcome is written beside it, in words. */}
          <span
            aria-hidden="true"
            class={styles.dot}
            style={{ "--dot-color": `var(${faultToken(attempt.fault)})` }}
          />
          <div class={styles.stack}>
            <span class={styles.outcomeName}>{outcomeLabel(attempt.outcome)}</span>
            <span class={styles.sub}>{faultLabel(attempt.fault)}</span>
          </div>
        </div>
      ),
    },
    {
      id: "why",
      header: "Status / error",
      cell: (attempt) => (
        <div class={styles.stack}>
          <span>{attempt.httpStatus === null ? "never reached" : attempt.httpStatus}</span>
          <Show fallback={<span class={styles.sub}>—</span>} when={attempt.errorClass}>
            {(errorClass) => <span class={styles.mono}>{errorClass()}</span>}
          </Show>
        </div>
      ),
    },
    {
      id: "request",
      header: "Request",
      cell: (attempt) => (
        <div class={styles.stack}>
          {/* The router's own id, always present. Shortened; the full value is on hover. */}
          <span class={styles.mono} title={attempt.correlationId}>
            {shortId(attempt.correlationId)}
          </span>
          <span class={styles.sub}>
            {`attempt ${attempt.attempt}`}
            <Show when={attempt.clientRequestId}>
              {(clientId) => (
                <span class={styles.mono} title={`x-request-id: ${clientId()}`}>
                  {` · ${clientId()}`}
                </span>
              )}
            </Show>
          </span>
        </div>
      ),
    },
    {
      // One column, not two: "which account served it" and "which key asked" are read together,
      // and eight columns already push this table into its horizontal scroller.
      id: "who",
      header: "Account / key",
      cell: (attempt) => (
        <div class={styles.stack}>
          <Subject subject={attempt.account} />
          <span class={styles.sub}>
            <Subject subject={attempt.key} />
          </span>
        </div>
      ),
    },
    {
      id: "model",
      header: "Model",
      cell: (attempt) => (
        <div class={styles.stack}>
          <span class={styles.mono}>{attempt.model}</span>
          <Show when={attempt.upstreamModel !== null && attempt.upstreamModel !== attempt.model}>
            <span class={styles.sub}>{`sent as ${attempt.upstreamModel}`}</span>
          </Show>
        </div>
      ),
    },
    {
      id: "latency",
      header: "Latency",
      numeric: true,
      cell: (attempt) => (
        <div class={styles.stack}>
          <span>{`${attempt.latencyMs} ms`}</span>
          {/* The two figures are measured from **different starts**, and the tooltip says so
              rather than leaving a reader to assume ttfb is a slice of the number above it:
              latency runs from this attempt beginning, ttfb from the request entering the
              router — so on a chain, ttfb legitimately exceeds a later attempt's latency. */}
          <span
            class={styles.sub}
            title="Latency is this attempt alone. Router overhead is the time the router itself added. Time to first byte is measured from the request entering the router, so it spans every attempt before this one."
          >
            {`+${attempt.routerOverheadMs} ms router · ${
              attempt.ttfbMs === null ? "no first byte" : `${attempt.ttfbMs} ms ttfb`
            }`}
          </span>
        </div>
      ),
    },
    {
      // Tokens are deliberately absent. Every other panel on this screen counts them per key,
      // account and model; this one is a diagnosis, and a ninth column costs more than it explains.
      id: "path",
      header: "Path",
      cell: (attempt) => (
        <div class={styles.stack}>
          <Show fallback={<span class={styles.sub}>—</span>} when={attempt.egressMode}>
            {(mode) => <Badge tone="neutral">{mode()}</Badge>}
          </Show>
          {/* Whether bytes reached the client. A streamed attempt is never retried, so this is
              also how a reader tells a truncated stream from a failure before the first byte. */}
          <span class={styles.sub}>{attempt.streamed ? "streamed" : "not streamed"}</span>
        </div>
      ),
    },
  ]

  return (
    <Table
      caption={`Newest first, at most ${props.limit} attempts. A row is one upstream attempt, not one client request — a failover chain of three writes three rows under one request id. No body is ever stored; a failure is recorded by error class, never by message.`}
      columns={columns()}
      emptyMessage="Nothing was routed in this window."
      rowId={(attempt) => attempt.id}
      rows={props.attempts}
    />
  )
}

/**
 * A key, account or pool on one attempt. A missing name renders as a word rather than a blank
 * cell: usage rows outlive what they name, and a reader must never have to guess whether a row is
 * broken or simply unattributed.
 */
function Subject(props: { readonly subject: RecentSubject }) {
  return (
    <Show
      fallback={
        <span class={styles.sub}>{props.subject.note === "deleted" ? "(deleted)" : "—"}</span>
      }
      when={props.subject.label}
    >
      {(label) => (
        <span class={styles.subject} title={props.subject.id ?? undefined}>
          {label()}
        </span>
      )}
    </Show>
  )
}
