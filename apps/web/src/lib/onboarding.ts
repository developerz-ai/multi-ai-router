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
 * The walk is done exactly when all three exist — not the moment an account does. Pooling is the
 * product (CLAUDE.md), so the guided panel keeps nudging toward a pool even after the first
 * account lands, and a key is the thing a tool actually needs to call the router.
 */
export function onboardingComplete(counts: OnboardingCounts): boolean {
  return counts.accounts > 0 && counts.pools > 0 && counts.keys > 0
}

/**
 * `PUBLIC_URL` wins when the operator configured one (docs/idea/09-deployment.md); otherwise the
 * browser's own origin is correct, never a guess — the console and the API are always served by
 * the same Hono process on the same origin (CLAUDE.md non-negotiable 8: no CORS).
 */
export function routerBaseUrl(publicUrl: string | null, origin: string): string {
  return publicUrl ?? origin
}
