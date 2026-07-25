/**
 * Expiry-driven, single-flighted credential refresh for the OAuth subscriptions this router holds
 * tokens for. Nothing outside this directory reaches into a file inside it.
 *
 * Claude subscriptions are not served here and cannot be — see `./refresher.ts`.
 */

export type { StoredOAuthCredential } from "./credential"
export { readStoredOAuth, writeStoredOAuth } from "./credential"
export type { RefreshExchangeDeps, RefreshFailure, RefreshOutcome } from "./exchange"
export { refreshCredential } from "./exchange"
export type { RefresherFromEnvDeps } from "./fromEnv"
export { refresherFromEnv } from "./fromEnv"
export type {
  CredentialRefreshConfig,
  CredentialRefresher,
  CredentialRefresherDeps,
} from "./refresher"
export { createCredentialRefresher } from "./refresher"
export type { RefreshTiming } from "./schedule"
export { MAX_TIMER_MS, refreshDueAt, retryDelayMs, timerDelayMs } from "./schedule"
export type { RefreshStatusDeps } from "./status"
export { parkForReauth, reviveAfterRefresh } from "./status"
