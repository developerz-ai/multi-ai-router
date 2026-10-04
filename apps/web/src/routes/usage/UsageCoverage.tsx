import { Show } from "solid-js"
import type { UsageSummary } from "../../lib/api/usage"
import { formatCount } from "../../lib/format"

/** The chart and retained-detail panels answer different ranges after raw retention. */
export function UsageCoverage(props: {
  readonly summary: Pick<UsageSummary, "coverage" | "bucket">
}) {
  const coverage = () => props.summary.coverage
  return (
    <section aria-label="Usage evidence coverage">
      <p>
        Event-time history · {coverage().bucketWidth} {props.summary.bucket}
        {coverage().bucketWidth === 1 ? "" : "s"} per chart point.
      </p>
      <Show when={coverage().legacy}>
        <p>
          Legacy daily history is preserved. Earlier request counts may be approximate or
          unavailable.
        </p>
      </Show>
      <Show when={coverage().incomplete}>
        <p>
          Some history lacks evidence for this exact range. Missing evidence is not zero traffic.
        </p>
      </Show>
      <p>
        Latency and failure outcomes use {formatCount(coverage().retainedDetail.attempts)} retained
        attempt{coverage().retainedDetail.attempts === 1 ? "" : "s"}.
        {coverage().incomplete
          ? ` The historical denominator is incomplete; ${formatCount(coverage().retainedDetail.totalAttempts)} attempts are currently accounted for.`
          : ` The complete historical denominator is ${formatCount(coverage().retainedDetail.totalAttempts)} attempts.`}
        {coverage().retainedDetail.from === null
          ? " No retained detail is available."
          : ` Detail covers ${coverage().retainedDetail.from} to ${coverage().retainedDetail.to ?? "unknown"}.`}
      </p>
      <Show when={coverage().breakdown.truncated.length > 0}>
        <p>
          Breakdown tables show at most {coverage().breakdown.maxRows} rows. Additional groups in{" "}
          {coverage().breakdown.truncated.join(", ")} contribute to headline totals.
        </p>
      </Show>
    </section>
  )
}
