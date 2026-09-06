import {
  PG_MAX_BIND_PARAMETERS,
  USAGE_RECORD_BIND_PARAMETERS_PER_ROW,
  USAGE_RECORD_MAX_BATCH_ROWS,
} from "@multi-ai-router/db"
import { z } from "zod"

/**
 * The field vocabulary `env.ts` builds its schema from — what a value must *look like*, separate
 * from which variables exist and what they default to.
 *
 * The rule this file exists to make enforceable: **a numeric knob accepts `0` only where zero is
 * a setting an operator could mean.** Everywhere else `0` is a kill switch wearing a number's
 * clothes — the mechanism stops, nothing logs, traffic keeps flowing, and the only symptom is an
 * absence: no usage rows, no retention, no breaker, no cache. Those variables take
 * {@link atLeastOne} and boot refuses zero by name.
 *
 * {@link ZERO_IS_LEGAL} is the other half: the short list where zero *is* a setting, each with
 * what it means. A drift guard walks the schema and holds every numeric variable to one list or
 * the other, so the next knob added cannot default into being a silent kill switch.
 */

export const nonEmpty = z.string().min(1)

export const wholeNumber = z.string().regex(/^\d+$/, "must be a whole number").transform(Number)

/** For a ceiling where zero is not "unlimited" but "nothing ever runs". */
export const atLeastOne = wholeNumber.refine((v) => v >= 1, "must be at least 1")

/**
 * Rows per usage insert, bounded at both ends because both ends lose *all* usage data
 * silently while traffic keeps flowing.
 *
 * Above the ceiling, the batch outgrows Postgres' bind-parameter limit, so the server
 * rejects the statement — every flush, identically, forever — and the recorder never
 * re-queues a batch its writer refused (that would starve the queue behind it). At zero,
 * the drain takes nothing and the queue simply sheds until it overflows. Either way the
 * only symptom is an empty usage table, which is why this is a boot failure and not a
 * clamp: a router that quietly records nothing is worse than one that will not start.
 */
export const usageBatchSize = atLeastOne.refine(
  (v) => v <= USAGE_RECORD_MAX_BATCH_ROWS,
  `must be at most ${USAGE_RECORD_MAX_BATCH_ROWS}: Postgres binds at most ` +
    `${PG_MAX_BIND_PARAMETERS} parameters per statement and one usage row costs ` +
    `${USAGE_RECORD_BIND_PARAMETERS_PER_ROW} of them ` +
    `(${PG_MAX_BIND_PARAMETERS} / ${USAGE_RECORD_BIND_PARAMETERS_PER_ROW} = ` +
    `${USAGE_RECORD_MAX_BATCH_ROWS})`,
)

export const flag = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1")

/** A share of something, written as a decimal in 0..1. */
export const fraction = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "must be a number")
  .transform(Number)
  .refine((v) => v >= 0 && v <= 1, "must be between 0 and 1")

export const absoluteUrl = z.string().refine((v) => URL.canParse(v), "must be an absolute URL")

const ENCRYPTION_KEY_BYTES = 32
const BASE64_SHAPE = /^[A-Za-z0-9+/_-]+={0,2}$/

/** Decodes a base64 (or base64url) `ENCRYPTION_KEY`, or null when it is not 32 bytes. */
export function decodeEncryptionKey(value: string): Uint8Array | null {
  const normalized = value.trim()
  if (normalized.length === 0 || !BASE64_SHAPE.test(normalized)) return null
  const bytes = Buffer.from(normalized, "base64")
  return bytes.byteLength === ENCRYPTION_KEY_BYTES ? new Uint8Array(bytes) : null
}

export const encryptionKey = z
  .string()
  .refine(
    (v) => decodeEncryptionKey(v) !== null,
    `must decode to ${ENCRYPTION_KEY_BYTES} bytes — generate with: openssl rand -base64 32`,
  )

/**
 * The numeric variables where `0` is a setting rather than an off switch, and what it means.
 *
 * Every one of these is a *bound on something optional* — a wait, a cooldown, a negative cache,
 * a spread. Removing the bound leaves the router doing its job, just without that particular
 * courtesy, and the effect is visible in behaviour an operator can see. That is the whole test
 * for membership: with the knob at zero, does the router still route, record, expire and
 * recover? If the answer is no for any of them, the variable belongs on `atLeastOne` instead.
 *
 * Held to the schema by the drift guard in `test/unit/env.test.ts`, which walks every numeric
 * field and demands that anything absent here refuses `0` at boot.
 */
export const ZERO_IS_LEGAL: ReadonlyMap<string, string> = new Map([
  ["PORT", "let the kernel pick an ephemeral port; the boot log names the one it bound"],
  ["SHUTDOWN_DRAIN_MS", "close in-flight responses immediately instead of waiting for them"],
  [
    "SHUTDOWN_READY_GRACE_MS",
    "close the listener as soon as /readyz starts refusing, without waiting for a load balancer to notice",
  ],
  // postgres.js treats a falsy timer interval as one that never fires (`src/connection.js#timer`),
  // so zero on either of these reads as *never*, not *at once*. Both leave the router routing,
  // recording and recovering — they only give up a courtesy the pool does for long-lived processes.
  ["DB_POOL_IDLE_TIMEOUT_SECONDS", "keep an idle connection open forever instead of closing it"],
  ["DB_POOL_MAX_LIFETIME_SECONDS", "never recycle a pooled connection on age"],
  [
    "DB_POOL_CLOSE_TIMEOUT_SECONDS",
    "destroy the pool at shutdown instead of waiting for in-flight queries",
  ],
  [
    "CLAUDE_SDK_CREDENTIAL_REFRESH_SKEW_SECONDS",
    "guard the refresh window with no lead time — one subprocess at a time only once the access " +
      "token has actually expired, rather than from a margin before it",
  ],
  ["ACCOUNT_RECHECK_COOLDOWN_SECONDS", "no cooldown between manual Re-check now probes"],
  ["ACCOUNT_TEST_NOW_COOLDOWN_SECONDS", "no cooldown between manual Test now presses"],
  ["KEY_CACHE_NEGATIVE_TTL_SECONDS", "do not cache a failed key lookup at all"],
  ["SESSION_CACHE_NEGATIVE_TTL_SECONDS", "do not cache an absent session binding at all"],
  ["SCHEDULER_JITTER_FRACTION", "run every task exactly on its interval, unspread"],
  [
    "ADMIN_SESSION_TOUCH_INTERVAL_SECONDS",
    "persist a session slide on every authenticated request",
  ],
  [
    "ADMIN_CREDENTIAL_METADATA_TTL_SECONDS",
    "re-read a subscription's credential file on every admin accounts read",
  ],
  ["CLAUDE_SDK_USAGE_GAUGE_MIN_INTERVAL_SECONDS", "ask the usage gauge on every subscription turn"],
])
