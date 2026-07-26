import { z } from "zod"
import type { RouterErrorCode } from "../errors"

/**
 * How one upstream **attempt** ended — the value on every `UsageRecord` row and the label on
 * `router_upstream_attempts_total`.
 *
 * This is deliberately **not** `"success" | RouterErrorCode`. That union was both too wide and too
 * narrow: it admitted admin-plane codes (`admin_auth_failed`, `csrf_token_invalid`) that a data-plane
 * row can never carry, while having no member at all for the two outcomes that happen most often
 * after `success` — the upstream answered with an error we relayed, and the client sent a request no
 * account would have accepted. Both were being recorded as `no_healthy_account`, which reads as "the
 * operator has no capacity" when the truth was "the provider had a bad minute" or "the caller sent
 * malformed JSON".
 *
 * The taxonomy is sized by one question: *"3% of my requests failed — whose problem is that?"* An
 * operator must be able to answer it from a `GROUP BY outcome` on this column alone, with no join
 * and no log correlation, which is why every value below is separated from its neighbours by a
 * **different remedy**, not by a different message. See {@link usageOutcomeFault} for the coarser
 * roll-up the console's error breakdown groups by.
 *
 * Stored as `text`, not a Postgres enum, so observing a new outcome costs a core change and not a
 * core change plus a migration (`packages/db/src/schema/enums.ts`).
 */
export const UsageOutcome = z.enum([
  /** Bytes were relayed and the upstream did not signal an error. */
  "success",

  // --- the caller must change something ------------------------------------
  /** The upstream rejected the request as malformed. Bad at every account; never a router fault. */
  "client_error",
  /** The router refused to convert the request across dialects rather than drop a contract field. */
  "translation_failed",
  /** The presented router key is unknown, revoked, or expired. */
  "key_revoked",
  /** The key's scope intersected the pool to nothing, or named an account it may not reach. */
  "scope_violation",
  /**
   * The key spent its own configured ceiling. The caller's problem, not the pool's — kept apart
   * from `quota_exhausted` so a throttled client never reads as an operator out of capacity.
   */
  "key_rate_limited",

  // --- the operator has no capacity to give --------------------------------
  /** Nothing in scope could serve this, for a reason that is not quota, credits, or scope. */
  "no_healthy_account",
  /** A rate-limit window is spent. Temporary, clock-recoverable. Never folded into the next one. */
  "quota_exhausted",
  /** The balance is drained or billing is dead. Permanent until a human acts. Never retried. */
  "credits_exhausted",

  // --- the upstream misbehaved ---------------------------------------------
  /** The provider answered with an error of its own, or the connection failed. `httpStatus`
   *  separates the two: an integer means it answered, `null` means we never reached it. */
  "upstream_error",
  /** The upstream (or the SDK subprocess) did not answer within its deadline. */
  "upstream_timeout",
  /** The provider rejected *our* credential. The Account needs re-authenticating. */
  "upstream_auth_failed",

  // --- the router itself broke ---------------------------------------------
  /** Stored credential material would not decrypt — a wrong or rotated `ENCRYPTION_KEY`. */
  "credential_decrypt_failed",
  /** An unclassified throw inside the router. The last resort, never the convenient default. */
  "router_error",
])
export type UsageOutcome = z.infer<typeof UsageOutcome>

/** The one non-failure outcome. */
export const USAGE_OUTCOME_SUCCESS = "success" satisfies UsageOutcome

export function isSuccessOutcome(outcome: UsageOutcome): boolean {
  return outcome === USAGE_OUTCOME_SUCCESS
}

/**
 * Where a failed attempt's fault lies — the axis the console's error breakdown groups by, and the
 * shortest honest answer to *"whose problem is that 3%"*.
 *
 * Four failure groups, each with a different owner and a different next action: the caller fixes
 * its request or presents a different key; the operator adds capacity, tops up, or waits out a
 * window; the provider is having a bad time and nobody here can do anything; or we have a bug.
 * Collapsing any two of them produces a number an operator cannot act on.
 */
export const UsageFault = z.enum(["none", "client", "capacity", "upstream", "router"])
export type UsageFault = z.infer<typeof UsageFault>

const FAULT_BY_OUTCOME: Readonly<Record<UsageOutcome, UsageFault>> = {
  success: "none",

  client_error: "client",
  translation_failed: "client",
  key_revoked: "client",
  scope_violation: "client",
  key_rate_limited: "client",

  no_healthy_account: "capacity",
  quota_exhausted: "capacity",
  credits_exhausted: "capacity",

  upstream_error: "upstream",
  upstream_timeout: "upstream",
  upstream_auth_failed: "upstream",

  credential_decrypt_failed: "router",
  router_error: "router",
}

export function usageOutcomeFault(outcome: UsageOutcome): UsageFault {
  return FAULT_BY_OUTCOME[outcome]
}

/**
 * The outcome a `RouterError` is recorded under. Total over {@link RouterErrorCode} on purpose —
 * adding an error code in `errors.ts` without deciding how it reports is a compile error here.
 *
 * The two admin-plane codes fold into `router_error` because the admin plane writes no usage rows
 * at all: seeing either of them on an attempt would mean a data-plane handler threw something from
 * the wrong plane, which is a bug and reports as one.
 */
const OUTCOME_BY_ERROR_CODE: Readonly<Record<RouterErrorCode, UsageOutcome>> = {
  no_healthy_account: "no_healthy_account",
  quota_exhausted: "quota_exhausted",
  credits_exhausted: "credits_exhausted",
  scope_violation: "scope_violation",
  key_revoked: "key_revoked",
  key_rate_limited: "key_rate_limited",
  upstream_auth_failed: "upstream_auth_failed",
  upstream_timeout: "upstream_timeout",
  credential_decrypt_failed: "credential_decrypt_failed",
  translation_failed: "translation_failed",
  admin_auth_failed: "router_error",
  csrf_token_invalid: "router_error",
  // `GET /v1/models/:id` never runs an attempt and never writes a `UsageRecord` — this only
  // satisfies the total-over-`RouterErrorCode` mapping. If it ever did report, "the id this key
  // asked about doesn't exist for it" is a caller-fixable condition, same family as scope.
  model_not_found: "client_error",
}

export function usageOutcomeForErrorCode(code: RouterErrorCode): UsageOutcome {
  return OUTCOME_BY_ERROR_CODE[code]
}
