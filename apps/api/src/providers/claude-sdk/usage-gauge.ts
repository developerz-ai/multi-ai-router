import type { Logger } from "../../logging/logger"
import { readSdkUsageGauge, type SdkUsageGaugeReading } from "./quota-reading"

/**
 * The continuous half of a subscription's quota picture: the plan-usage percentages behind the
 * CLI's `/usage`, read once per turn through the SDK's own query object
 * (docs/idea/11-anthropic-agent-sdk.md §5).
 *
 * **Why it exists.** `rate_limit_event` carries `utilization` only near the limit, so the console
 * showed `—` for every window of every subscription until one was nearly spent — the operator could
 * not see usage, which is the one thing a pool of subscriptions has to make visible. The SDK 0.3.261
 * query object exposes the structured `/usage` answer, and calling it is sanctioned: it is the SDK
 * asking, inside the Account's own `CLAUDE_CONFIG_DIR`, with a credential this router never touches
 * (CLAUDE.md non-negotiable 1). Nothing is forged and no token crosses the subprocess boundary.
 *
 * **Never on the response path.** A gauge is started only after the turn's first content message has
 * already been handed to the renderer, so it cannot move time-to-first-token; it is awaited by
 * nothing the client waits on; it is bounded by `timeoutMs`; and every failure — timeout, a closed
 * query, a malformed payload — costs this reading and nothing else. The SDK names the method as
 * experimental, and this module treats it that way: the payload is validated by a tolerant schema,
 * an unreadable one is logged at `debug` and dropped, never raised.
 *
 * **Coalesced per account.** At most one call per `minIntervalMs` per Account, counted from when a
 * reading *started* rather than landed, so a burst of parallel coding agents on one subscription
 * asks the usage endpoint once, not once per turn. A failed reading counts too — retrying a failing
 * endpoint every turn is precisely the hammering the interval exists to prevent.
 *
 * `rate_limits_available: false` is the SDK saying plan limits do not apply — an API key, or a login
 * whose scopes lack `user:profile`. Reported once per Account at `info`, not once per turn: it is a
 * fact about the login, and the operator can act on it exactly once.
 */

/** The one method this module calls on a query object, optional because a test's fake may lack it. */
export interface SdkUsageGaugeSource {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (opts?: {
    skipBehaviors?: boolean
  }) => Promise<unknown>
}

export interface SdkUsageGaugeDeps {
  /** `CLAUDE_SDK_USAGE_GAUGE`. Off means `observe` resolves immediately and nothing is asked. */
  readonly enabled: boolean
  /** `CLAUDE_SDK_USAGE_GAUGE_TIMEOUT_MS`. The most a reading may take before it is dropped. */
  readonly timeoutMs: number
  /** `CLAUDE_SDK_USAGE_GAUGE_MIN_INTERVAL_SECONDS`, in milliseconds. */
  readonly minIntervalMs: number
  /**
   * Where a validated reading lands. The composition root folds it into the quota store and the
   * health store; this module knows neither. Must not throw — a throw here is logged and dropped.
   */
  readonly onReading: (accountId: string, reading: SdkUsageGaugeReading, now: Date) => void
  readonly logger?: Logger
  readonly now?: () => Date
}

export interface SdkUsageGauge {
  /**
   * Takes one reading if one is due for this Account. Resolves once the reading has landed or been
   * dropped; never rejects and never throws, so a caller may `void` it or await it as it likes.
   */
  observe(accountId: string, source: SdkUsageGaugeSource): Promise<void>
}

/** The clock stand-in and the settled promise, so a disabled gauge costs one allocation. */
const DONE: Promise<void> = Promise.resolve()

export function createSdkUsageGauge(deps: SdkUsageGaugeDeps): SdkUsageGauge {
  const now = deps.now ?? (() => new Date())
  const log = deps.logger?.child({ component: "sdk-usage-gauge" })
  const startedAt = new Map<string, number>()
  const reportedUnavailable = new Set<string>()

  const due = (accountId: string, at: number): boolean => {
    const last = startedAt.get(accountId)
    return last === undefined || at - last >= deps.minIntervalMs
  }

  return {
    observe(accountId, source) {
      if (!deps.enabled) return DONE
      const read = source.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
      if (typeof read !== "function") return DONE
      const at = now()
      if (!due(accountId, at.getTime())) return DONE
      startedAt.set(accountId, at.getTime())

      return take(accountId, () => read.call(source, { skipBehaviors: true }))
    },
  }

  async function take(accountId: string, read: () => Promise<unknown>): Promise<void> {
    let payload: unknown
    try {
      payload = await withTimeout(read(), deps.timeoutMs)
    } catch (error) {
      log?.debug("sdk usage gauge unavailable", { accountId, reason: reasonOf(error) })
      return
    }

    const readAt = now()
    const reading = readSdkUsageGauge(payload, readAt)
    if (reading === null) {
      log?.debug("sdk usage gauge payload unreadable", { accountId })
      return
    }
    if (!reading.available) {
      if (!reportedUnavailable.has(accountId)) {
        reportedUnavailable.add(accountId)
        log?.info("sdk usage gauge reports no plan limits for this account", {
          accountId,
          subscriptionType: reading.subscriptionType,
        })
      }
      return
    }
    reportedUnavailable.delete(accountId)

    try {
      deps.onReading(accountId, reading, readAt)
    } catch (error) {
      log?.warn("sdk usage gauge reading not applied", { accountId, reason: reasonOf(error) })
    }
  }
}

/** Rejects with `timeout` once `ms` has passed; the underlying promise is left to settle alone. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** The error's own sentence, bounded. Never a payload — the SDK's message is a plain diagnostic. */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}
