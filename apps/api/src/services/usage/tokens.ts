import { createResponseObserver } from "./response-observer"
import type { ResponseObservationSpec } from "./response-observer-types"

/** Persisted counts: uncached input plus separately priced cache components. */
export interface TokenCounts {
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}
export const ZERO_TOKENS: TokenCounts = Object.freeze({
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})
export interface TokenObserver {
  observe(chunk: Uint8Array): void
  /** Final reading, after EOF; use ResponseObserver.snapshot for a running stream. */
  counts(): TokenCounts
}
export const NO_TOKEN_OBSERVER: TokenObserver = {
  observe: () => undefined,
  counts: () => ZERO_TOKENS,
}
/** Compatibility adapter with an explicit upstream observation contract. */
export function createTokenObserver(spec: ResponseObservationSpec): TokenObserver {
  const observer = createResponseObserver(spec)
  return { observe: (chunk) => observer.observe(chunk), counts: () => observer.finish().counts }
}
