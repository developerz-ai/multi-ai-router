import type { QuotaWindowState } from "@multi-ai-router/core"
import type { RateLimitWindow } from "../../providers"
import { type BreakerState, HEALTHY, type ModelRefusal } from "../routing"
import type { TokenWindow } from "./health-tokens"

export interface AccountHealthState {
  readonly breaker: BreakerState
  readonly inFlight: number
  /** Output tokens over the last one to two `tokenWindowMs` windows (02.10); since boot without one. */
  readonly recentTokens: number
  /** The two buckets `recentTokens` sums, when a window is configured. */
  readonly tokenWindow?: TokenWindow
  readonly limiterWindows: readonly RateLimitWindow[]
  readonly quotaWindows: readonly QuotaWindowState[]
  readonly lastSignalAt: Date | null
  readonly probeHeldUntil: Date | null
  /** Upstream models held off this account, refused as unknown (10.16) or throttled alone. */
  readonly refusedModels?: ReadonlyMap<string, ModelRefusal>
}

export const FRESH: AccountHealthState = {
  breaker: HEALTHY,
  inFlight: 0,
  recentTokens: 0,
  limiterWindows: [],
  quotaWindows: [],
  lastSignalAt: null,
  probeHeldUntil: null,
}
