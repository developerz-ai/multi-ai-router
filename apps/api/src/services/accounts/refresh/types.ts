import type { RefreshOutcome } from "./exchange"
import type { RefreshTiming } from "./schedule"

export interface CredentialRefreshConfig extends RefreshTiming {
  readonly maxAttempts: number
  readonly timeoutMs: number
  readonly shutdownDrainMs?: number
}
export interface CredentialRefresher {
  start(): Promise<void>
  stop(): Promise<void>
  sync(accountId: string): Promise<void>
  /** Also runs a parked account's one refresh; a spent credential comes back `not-refreshable`. */
  refreshNow(accountId: string): Promise<RefreshOutcome>
  /** An operator's re-check: one more attempt for a parked account, even on a spent credential. */
  retryParked(accountId: string): Promise<RefreshOutcome>
}
