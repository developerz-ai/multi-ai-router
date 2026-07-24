import { PageHeader } from "../components/PageHeader"
import { Placeholder } from "../components/Placeholder"

export default function AccountsRoute() {
  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle="Upstream subscriptions and API keys. Many accounts of the same provider is the normal case."
      />
      <Placeholder
        icon="accounts"
        summary="One row per upstream account, with quota and reset visible without opening anything."
        items={[
          "Status, provider, label, pool membership, per-row usage totals and a sparkline",
          "Quota utilization per window with lastCheckedAt beside every figure",
          "Reset as absolute time and countdown, labeled reported / estimated / unknown",
          "exhausted shows 'needs top-up' and never a countdown",
          "Re-check now, per account and for all accounts — the same probe the breaker runs",
          "Connect a subscription by redirect capture or manual code paste; both first-class",
        ]}
      />
    </>
  )
}
