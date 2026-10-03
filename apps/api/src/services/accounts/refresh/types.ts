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
  refreshNow(accountId: string): Promise<RefreshOutcome>
}
