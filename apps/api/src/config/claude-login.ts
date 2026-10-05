import type { z } from "zod"
import { CLI_REFRESH_LEAD_MS } from "../providers/claude-sdk/credential-freshness"
import { atLeastOne } from "./fields"

/**
 * A Claude subscription's two credential clocks, as configuration (CLAUDE.md non-negotiable 11).
 *
 * - The **login** (refresh token) lasts roughly four weeks and only an interactive re-login moves
 *   it. `ASSUMED_LIFETIME_DAYS` is what the router assumes when the CLI did not persist the
 *   instant itself; `RENEWAL_WARN_DAYS` is when the console banner and the daily warn line start;
 *   `LOGIN_LIFETIME_WATCH_INTERVAL_MINUTES` is that warn line's cadence.
 * - The **access** token lasts ~8 h and the CLI refreshes it inside its own five-minute lead.
 *   `KEEPALIVE_INTERVAL_SECONDS` is how often the keepalive looks for a token inside that lead;
 *   `KEEPALIVE_RETRY_MINUTES` is how long it leaves a credential alone after a turn that did not
 *   refresh it, so a broken account is not billed a turn every tick.
 */
export const CLAUDE_LOGIN_ENV_FIELDS = {
  CLAUDE_LOGIN_ASSUMED_LIFETIME_DAYS: atLeastOne.optional(),
  CLAUDE_LOGIN_RENEWAL_WARN_DAYS: atLeastOne.optional(),
  LOGIN_LIFETIME_WATCH_INTERVAL_MINUTES: atLeastOne.optional(),
  CLAUDE_SDK_CREDENTIAL_KEEPALIVE_INTERVAL_SECONDS: atLeastOne.optional(),
  CLAUDE_SDK_CREDENTIAL_KEEPALIVE_RETRY_MINUTES: atLeastOne.optional(),
}

/** Headroom left inside the lead for one tick's own work (the turns run concurrently). */
const TICK_WORK_SECONDS = 30

export interface ClaudeLoginConfig {
  readonly assumedLifetimeDays: number
  readonly renewalWarnDays: number
  readonly watchIntervalMinutes: number
  readonly keepaliveIntervalSeconds: number
  readonly keepaliveRetryMinutes: number
}

export function readClaudeLoginEnv(
  raw: {
    CLAUDE_LOGIN_ASSUMED_LIFETIME_DAYS?: number
    CLAUDE_LOGIN_RENEWAL_WARN_DAYS?: number
    LOGIN_LIFETIME_WATCH_INTERVAL_MINUTES?: number
    CLAUDE_SDK_CREDENTIAL_KEEPALIVE_INTERVAL_SECONDS?: number
    CLAUDE_SDK_CREDENTIAL_KEEPALIVE_RETRY_MINUTES?: number
    SCHEDULER_JITTER_FRACTION?: number
  },
  ctx: z.RefinementCtx,
): { readonly claudeLogin: ClaudeLoginConfig } | undefined {
  // Three minutes: with the default ±20 % jitter the widest gap between two ticks is 216 s, inside
  // the CLI's 300 s lead with room for one tick's own work — so every token is seen inside the
  // lead at least once. Under a wider configured jitter the *default* shrinks to keep that true;
  // an explicit cadence that can step over the lead is refused, not clamped: it would look
  // configured and let tokens lapse exactly as before.
  const jitter = raw.SCHEDULER_JITTER_FRACTION ?? 0.2
  const leadSeconds = CLI_REFRESH_LEAD_MS / 1_000
  const keepaliveIntervalSeconds =
    raw.CLAUDE_SDK_CREDENTIAL_KEEPALIVE_INTERVAL_SECONDS ??
    Math.min(180, Math.floor((leadSeconds - TICK_WORK_SECONDS) / (1 + jitter)))
  if (keepaliveIntervalSeconds * (1 + jitter) >= leadSeconds) {
    ctx.addIssue({
      code: "custom",
      path: ["CLAUDE_SDK_CREDENTIAL_KEEPALIVE_INTERVAL_SECONDS"],
      message:
        `must be below ${Math.floor(leadSeconds / (1 + jitter))} with SCHEDULER_JITTER_FRACTION ` +
        `${jitter}: the claude CLI refreshes an access token only within ${leadSeconds} s of its ` +
        `expiry, and a keepalive whose ticks can be further apart than that steps over the window`,
    })
    return undefined
  }

  const assumedLifetimeDays = raw.CLAUDE_LOGIN_ASSUMED_LIFETIME_DAYS ?? 28
  const renewalWarnDays = raw.CLAUDE_LOGIN_RENEWAL_WARN_DAYS ?? 5
  if (renewalWarnDays >= assumedLifetimeDays) {
    ctx.addIssue({
      code: "custom",
      path: ["CLAUDE_LOGIN_RENEWAL_WARN_DAYS"],
      message: `must be less than CLAUDE_LOGIN_ASSUMED_LIFETIME_DAYS (${assumedLifetimeDays}): a warn window as long as the login would warn from the moment of login`,
    })
    return undefined
  }

  return {
    claudeLogin: {
      assumedLifetimeDays,
      renewalWarnDays,
      // Daily: the warn line is one per account per day, and the scheduler resumes the interval
      // from the persisted last run, so a restart does not log it twice.
      watchIntervalMinutes: raw.LOGIN_LIFETIME_WATCH_INTERVAL_MINUTES ?? 1_440,
      keepaliveIntervalSeconds,
      // An hour: long enough that an account whose turns keep failing costs a handful of turns a
      // day, short enough that a transient failure is retried well inside the ~8 h token life.
      keepaliveRetryMinutes: raw.CLAUDE_SDK_CREDENTIAL_KEEPALIVE_RETRY_MINUTES ?? 60,
    },
  }
}
