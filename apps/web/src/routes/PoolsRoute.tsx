import { PageHeader } from "../components/PageHeader"
import { Placeholder } from "../components/Placeholder"

export default function PoolsRoute() {
  return (
    <>
      <PageHeader
        title="Pools"
        subtitle="A pool turns a set of accounts into one addressable, more reliable thing a key points at."
      />
      <Placeholder
        icon="pools"
        summary="Pool membership, selection policy, and whether the policy is doing what it was set to."
        items={[
          "Membership editing, with the effective candidate count per pool",
          "Selection policy per pool and its parameters",
          "Per-pool totals and the observed split across members",
          "Live count of members currently filtered out, by reason",
        ]}
      />
    </>
  )
}
