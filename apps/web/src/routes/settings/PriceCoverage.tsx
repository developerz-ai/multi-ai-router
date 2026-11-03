import { For, Show } from "solid-js"
import { Button } from "../../components/Button"
import type { PriceTable } from "../../lib/api/settings"

/** Coverage is assessed against configured upstream names, never guessed from a sibling model. */
export function PriceCoverage(props: {
  prices: PriceTable
  onPrice: (accountId: string, provider: string, model: string) => void
}) {
  return (
    <>
      <p>
        Inherited price snapshot: {props.prices.shippedAsOf}. Verification dates are
        source-specific.
      </p>
      <p>
        Kimi coding references apply only to subscription attribution, not metered Extra Usage.
        Preview models and cache-write usage without a known TTL remain unpriced unless you add an
        explicit override.
      </p>
      <p>
        A source with no verification date means its rows were not re-checked against the published
        page; their evidence is the inherited snapshot, dated per source below.
      </p>
      <For each={props.prices.sources ?? []}>
        {(source) => (
          <p>
            <a href={source.url} target="_blank" rel="noreferrer">
              {source.id}
            </a>
            :{" "}
            {source.verifiedAt === null
              ? `verification unknown; snapshot ${source.snapshotAsOf}`
              : `verified ${source.verifiedAt}`}
          </p>
        )}
      </For>
      <p>
        This router prices by published model id. A vendor-priced offering with no published model
        id is not priced here, so a request naming it costs unknown; an operator override is the way
        to price it.
      </p>
      <Show when={(props.prices.unpriced?.length ?? 0) > 0}>
        <p>
          These configured models have unknown cost. Add your contract’s USD rate; subscription
          attribution is separate from actual metered spend.
        </p>
        <For each={props.prices.unpriced ?? []}>
          {(row) => (
            <p>
              {props.prices.accounts?.find((account) => account.id === row.accountId)?.label ??
                row.accountId}{" "}
              / {row.provider} / {row.model ?? "model catalog unknown"}
              <Show when={row.model !== null}>
                <Button
                  tone="ghost"
                  onClick={() => props.onPrice(row.accountId, row.provider, row.model ?? "")}
                >
                  Add account price
                </Button>
              </Show>
              <Show when={row.model === null}>
                {" "}
                — Configure or discover upstream model names to assess coverage.
              </Show>
            </p>
          )}
        </For>
      </Show>
    </>
  )
}
