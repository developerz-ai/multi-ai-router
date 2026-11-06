import { StatTile } from "../../components/StatTile"
import { formatCost, formatCount, formatPercent } from "../../lib/format"
import type { useAllAccounts } from "../../lib/queries/accounts"
import type { usePools } from "../../lib/queries/pools"
import type { useKeys } from "../../lib/queries/router-keys"
import type { useUsageSummary } from "../../lib/queries/usage"

export interface FleetTilesProps {
  readonly accounts: ReturnType<typeof useAllAccounts>
  readonly pools: ReturnType<typeof usePools>
  readonly keys: ReturnType<typeof useKeys>
  readonly usage: ReturnType<typeof useUsageSummary>
  /**
   * `isRoutableNow`, not the status alone: an active sub with a spent window is a green dot every
   * request bounces off, and "5 routable now" above a fleet answering 429s is the exact headline
   * this screen exists not to print.
   */
  readonly routableNow: number
  readonly windowLabel: string
}

/** The overview's headline figures. Each tile follows its own query, so one failed read is one tile. */
export function FleetTiles(props: FleetTilesProps) {
  const totals = () => props.usage.data?.totals

  return (
    <>
      <StatTile
        label="Accounts"
        {...tile(
          props.accounts,
          () => String((props.accounts.data ?? []).length),
          () => `${props.routableNow} routable now`,
        )}
      />
      <StatTile
        label="Pools"
        {...tile(
          props.pools,
          () => String((props.pools.data ?? []).length),
          () => "Each one addressable by a key",
        )}
      />
      <StatTile
        label="Router keys"
        {...tile(
          props.keys,
          () => String((props.keys.data ?? []).length),
          () => `${(props.keys.data ?? []).filter((key) => !key.revoked).length} active`,
        )}
      />
      <StatTile
        label="Requests"
        {...tile(
          props.usage,
          () => formatCount(totals()?.requests ?? 0),
          () => props.windowLabel,
        )}
      />
      <StatTile
        label="Metered spend"
        {...tile(
          props.usage,
          () => formatCost(totals()?.costMetered ?? 0),
          () => "Notional shown apart",
        )}
      />
      <StatTile
        label="Error rate"
        {...tile(
          props.usage,
          () => formatPercent(totals()?.errors ?? 0, totals()?.attempts ?? 0),
          () => props.windowLabel,
        )}
      />
    </>
  )
}

/**
 * A tile's figures by its query's state. A failed read has to end the skeleton: `StatTile` reads
 * an absent value as "still loading", and that query is not going to answer.
 */
function tile(
  query: { readonly isSuccess: boolean; readonly isError: boolean },
  value: () => string,
  note: () => string,
): { readonly value?: string; readonly note?: string } {
  if (query.isSuccess) return { value: value(), note: note() }
  return query.isError ? { value: "—", note: "could not load" } : {}
}
