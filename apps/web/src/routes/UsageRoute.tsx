import { PageHeader } from "../components/PageHeader"
import { Placeholder } from "../components/Placeholder"

export default function UsageRoute() {
  return (
    <>
      <PageHeader
        title="Usage"
        subtitle="Who burned what — answered without anyone writing a query."
      />
      <Placeholder
        summary="Any dimension against any window, with the same measures in every cell."
        items={[
          "Slice by key, account, pool, model or session",
          "Windows: lifetime, today, 7d, 30d, custom from/to",
          "Requests and upstream attempts as separate numbers, never one figure",
          "Input tokens as the three-field sum, with cache read and cache creation broken out",
          "Metered and notional cost as separate totals, never summed",
          "Error rate, p50 / p95 latency, and router overhead beside it",
          "Time series stacked by key or account, quota gauges, top-N leaderboards",
        ]}
      />
    </>
  )
}
