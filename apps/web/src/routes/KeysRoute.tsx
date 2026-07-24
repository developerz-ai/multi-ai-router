import { PageHeader } from "../components/PageHeader"
import { Placeholder } from "../components/Placeholder"

export default function KeysRoute() {
  return (
    <>
      <PageHeader
        title="Keys"
        subtitle="Router keys are named and retrievable — view and copy a value at any time, no 'shown once' flow."
      />
      <Placeholder
        icon="keys"
        summary="Mint, scope, inspect and revoke the keys clients present to the router."
        items={[
          "Name, scope (all / pools / explicit accounts), created and last-used",
          "Reveal and copy the key value on demand; each reveal is audited",
          "Per-row usage totals for the selected window, with an inline sparkline",
          "Revoke confirms and states exactly which clients break",
        ]}
      />
    </>
  )
}
