import { Show } from "solid-js"
import { type UsageSummary, usageDimensionLabel } from "../../lib/api/usage"
import { formatCount, formatDate } from "../../lib/format"

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
          : ` Detail covers ${formatDate(coverage().retainedDetail.from)} to ${coverage().retainedDetail.to === null ? "unknown" : formatDate(coverage().retainedDetail.to)}.`}
      </p>
      <Show when={coverage().breakdown.truncated.length > 0}>
        <p>
          Breakdown tables show at most {coverage().breakdown.maxRows} row
          {coverage().breakdown.maxRows === 1 ? "" : "s"}. Additional groups in{" "}
          {coverage().breakdown.truncated.map(dimensionLabel).join(", ")} contribute to headline
          totals.
        </p>
      </Show>
    </section>
  )
}

function dimensionLabel(dimension: string): string {
  switch (dimension) {
    case "apiKeyId":
      return usageDimensionLabel("key")
    case "accountId":
      return usageDimensionLabel("account")
    case "poolId":
      return usageDimensionLabel("pool")
    case "model":
      return usageDimensionLabel("model")
    default:
      return "Other groups"
  }
}
