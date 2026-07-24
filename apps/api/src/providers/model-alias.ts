import type { DriverAccount } from "./types"

/**
 * Client model name -> the id this Account's upstream expects. **Identity on a miss** — the
 * router never guesses a substitute and never fails a request because a name is unmapped; the
 * upstream's own error is the honest answer (docs/idea/03-providers.md, and the product
 * invariant in CLAUDE.md: the client picks the model, the router picks the account).
 *
 * The map is per Account, not per Provider: two z.ai keys may map differently. Matching is exact
 * and case-sensitive — normalizing would be the router deciding that `Sonnet` and `sonnet` are
 * the same model, which is the upstream's call to make.
 */
export function mapModelAlias(account: DriverAccount, requestedModel: string): string {
  const aliases = account.modelAliases
  if (!aliases) return requestedModel
  return aliases[requestedModel] ?? requestedModel
}
