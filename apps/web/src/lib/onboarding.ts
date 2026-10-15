/**
 * Pure logic behind the Overview zero state: when the guided walk is done, and the base URL its
 * final step hands the operator. Split out of `OnboardingPanel` so both are testable with no DOM.
 */

export interface OnboardingCounts {
  readonly accounts: number
  readonly pools: number
  readonly keys: number
}

/**
 * The walk is done once an account and a key exist. Until then the panel nudges toward a pool,
 * because pooling is the product (CLAUDE.md) — but a pool is not a precondition for a working
 * deployment: a key can be scoped straight to accounts, and a deployment run that way (tesote's
 * router: two accounts, two account-scoped keys, live traffic) kept a "Get your first working key"
 * banner on its Overview forever, telling an operator with a working key to go get one.
 */
export function onboardingComplete(counts: OnboardingCounts): boolean {
  return counts.accounts > 0 && counts.keys > 0
}

/**
 * `PUBLIC_URL` wins when the operator configured one (docs/idea/09-deployment.md); otherwise the
 * browser's own origin is correct, never a guess — the console and the API are always served by
 * the same Hono process on the same origin (CLAUDE.md non-negotiable 8: no CORS).
 */
export function routerBaseUrl(publicUrl: string | null, origin: string): string {
  return publicUrl ?? origin
}
