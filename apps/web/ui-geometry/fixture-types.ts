// The wire shapes the fixture speaks. Accounts and keys ARE the SPA's own
// `lib/api/types.ts` types, so a wire change that breaks the console breaks this
// fixture at typecheck instead of silently rendering stale data; only the usage
// totals (a decimal-string wire shape the SPA does not export) are restated.
import type { AccountView, ApiKeyView } from "../src/lib/api/types"

/** The counts are arbitrary; only their width on screen is load-bearing. */
export interface WireTotals {
  readonly requests: number
  readonly attempts: number
  readonly errors: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costMetered: string
  readonly costNotional: string
  readonly unpriced: { readonly attempts: number | null; readonly since: string }
}

/** The SPA's own wire types — the fixture is checked against them, not a restated copy. */
export type FixtureAccount = AccountView

export type FixtureKey = ApiKeyView
