import type { UsageFault, UsageOutcome } from "@multi-ai-router/core"

// A failed attempt → the remedy it implies. Pure: no DOM, no clock, no fetch.
//
// The vocabulary is **not** defined here — `UsageOutcome` comes from
// `@multi-ai-router/core`, the one definition shared with the API and the
// database. This module owns only how each outcome groups and reads.
//
// Core already has a coarse axis for this: `UsageFault` — client, capacity,
// upstream, router — which answers *whose problem is that 3%*. It is the right
// answer to that question and the wrong one to the question an operator
// actually arrives with, because `quota_exhausted` and `credits_exhausted` are
// both `capacity` and their remedies are opposites. One is a window a clock
// refills; the other is a balance a human refills, and there is no timer that
// will ever fix the second. That is CLAUDE.md non-negotiable 7, and it is the
// whole reason this finer axis exists.
//
// So each class is **a status plus a next action**, and every class states the
// fault it refines. A unit test asserts the two agree for every outcome — the
// finer axis may split a fault, never contradict one.
//
// Core is imported **as a type only**: one runtime import of its Zod-backed
// vocabulary pulls Zod into this route's chunk (measured: 12 kB → 72 kB). The
// safety comes from the `Record` below being total over the union, so an outcome
// added upstream is a compile error here, plus the drift test — which may import
// core freely, since tests are not bundled.
//
// Colour is **not** decided here. Every class carries the `fault` it refines, and
// `faultToken` in `api/usage-recent.ts` already maps a fault to a semantic token
// for the live feed's dots. A second map keyed on the same union would be a
// second answer to one question, and the two would drift apart the first time
// either was touched.

export type FailureClassId =
  | "rate_limited"
  | "out_of_credits"
  | "out_of_scope"
  | "key_throttled"
  | "key_rejected"
  | "no_capacity"
  | "bad_request"
  | "upstream_failed"
  | "router_bug"

export interface FailureClass {
  readonly id: FailureClassId
  /** Words, never an enum member. */
  readonly label: string
  /**
   * The status the caller received — the number in their logs, which is how they will describe
   * this when they ask. `null` where a class genuinely has more than one: a relayed upstream error
   * carries the upstream's own status, and inventing a single one would be a guess.
   */
  readonly status: number | null
  /** Core's coarser axis, restated so the two can be asserted to agree rather than hoped to. */
  readonly fault: UsageFault
  /** One line an operator can act on. No jargon, no error codes. */
  readonly hint: string
}

export const FAILURE_CLASSES: Readonly<Record<FailureClassId, FailureClass>> = {
  rate_limited: {
    id: "rate_limited",
    label: "Rate limited",
    status: 429,
    fault: "capacity",
    hint: "A window is spent. It comes back on its own — the account is cooling down, not broken.",
  },
  out_of_credits: {
    id: "out_of_credits",
    label: "Out of credits",
    status: 402,
    fault: "capacity",
    hint: "A balance is drained or billing is dead. Needs a top-up; no timer will clear this.",
  },
  out_of_scope: {
    id: "out_of_scope",
    label: "Out of scope",
    status: 403,
    fault: "client",
    hint: "The key's scope intersected the pool to nothing. Widen the scope, or add the account to the pool.",
  },
  key_throttled: {
    id: "key_throttled",
    label: "Key throttled",
    status: 429,
    fault: "client",
    // Same status as `rate_limited` and deliberately a different row: the ceiling here is one the
    // operator set on one key, so the remedy is a setting rather than a wait for a provider.
    hint: "A key hit the ceiling you set on it. Raise the key's limit, or let the caller slow down.",
  },
  key_rejected: {
    id: "key_rejected",
    label: "Key rejected",
    status: 401,
    fault: "client",
    hint: "The key presented is unknown, revoked or expired. The caller is holding the wrong one.",
  },
  no_capacity: {
    id: "no_capacity",
    label: "No account available",
    status: 503,
    fault: "capacity",
    hint: "Nothing in scope could serve it, for a reason that is not quota, credits or scope. Check account health.",
  },
  bad_request: {
    id: "bad_request",
    label: "Request refused",
    // 400, 413 and a relayed upstream 4xx all land here — one number would be wrong twice.
    status: null,
    fault: "client",
    hint: "The request was refused as sent — malformed, untranslatable, or over the body ceiling. No account would have taken it.",
  },
  upstream_failed: {
    id: "upstream_failed",
    label: "Upstream failed",
    status: null,
    fault: "upstream",
    hint: "The provider errored, timed out, or rejected our credential. Check the account, then the provider's status page.",
  },
  router_bug: {
    id: "router_bug",
    label: "Router fault",
    status: 500,
    fault: "router",
    hint: "The router itself failed — a wrong ENCRYPTION_KEY, or a bug. This one is ours.",
  },
}

/**
 * Every failure outcome's class. Total over core's union minus `success`, so an outcome added
 * upstream fails this build until someone decides what an operator should do about it.
 */
const CLASS_BY_OUTCOME: Readonly<Record<Exclude<UsageOutcome, "success">, FailureClassId>> = {
  quota_exhausted: "rate_limited",
  credits_exhausted: "out_of_credits",
  scope_violation: "out_of_scope",
  key_rate_limited: "key_throttled",
  key_revoked: "key_rejected",
  no_healthy_account: "no_capacity",

  client_error: "bad_request",
  translation_failed: "bad_request",
  request_too_large: "bad_request",

  upstream_error: "upstream_failed",
  upstream_timeout: "upstream_failed",
  upstream_auth_failed: "upstream_failed",

  credential_decrypt_failed: "router_bug",
  router_error: "router_bug",
}

export function failureClassFor(outcome: Exclude<UsageOutcome, "success">): FailureClass {
  return FAILURE_CLASSES[CLASS_BY_OUTCOME[outcome]]
}

/**
 * The three classes the panel shows **even at zero**.
 *
 * "No account was rate limited today" is an answer, not an absence, and it is the answer that
 * stops an operator hunting. These are also the three non-negotiable 7 names, in the order it
 * names them: wait it out, go and pay, fix a scope.
 */
export const HEADLINE_FAILURE_CLASSES: readonly FailureClassId[] = [
  "rate_limited",
  "out_of_credits",
  "out_of_scope",
]

/** One outcome and its count, exactly as the summary reports it. */
export interface FailureCount {
  readonly outcome: Exclude<UsageOutcome, "success">
  readonly attempts: number
}

export interface FailureGroup {
  readonly klass: FailureClass
  readonly attempts: number
  /** What the class is made of, biggest first. Kept so a row can say *which* upstream failure. */
  readonly outcomes: readonly FailureCount[]
}

/**
 * Groups one window's failure counts into classes.
 *
 * The three headline classes come first and always, at zero or not. Everything else follows,
 * biggest first, and only when it happened — a screen listing nine classes of zero would bury the
 * one number that is not.
 *
 * Ties break on the class id so two equal counts never swap places between refreshes; the same
 * rule the server's fold uses, for the same reason.
 */
export function groupFailures(counts: readonly FailureCount[]): readonly FailureGroup[] {
  const groups = new Map<FailureClassId, FailureCount[]>(
    HEADLINE_FAILURE_CLASSES.map((id) => [id, []]),
  )

  for (const count of counts) {
    if (count.attempts <= 0) continue
    const id = CLASS_BY_OUTCOME[count.outcome]
    const existing = groups.get(id)
    if (existing === undefined) groups.set(id, [count])
    else existing.push(count)
  }

  const headline = new Set(HEADLINE_FAILURE_CLASSES)
  return [...groups]
    .map(([id, outcomes]) => ({
      klass: FAILURE_CLASSES[id],
      attempts: outcomes.reduce((sum, row) => sum + row.attempts, 0),
      outcomes: [...outcomes].sort(
        (a, b) => b.attempts - a.attempts || a.outcome.localeCompare(b.outcome),
      ),
    }))
    .sort((a, b) => {
      const aHead = headline.has(a.klass.id)
      const bHead = headline.has(b.klass.id)
      if (aHead !== bHead) return aHead ? -1 : 1
      if (aHead && bHead) {
        return (
          HEADLINE_FAILURE_CLASSES.indexOf(a.klass.id) -
          HEADLINE_FAILURE_CLASSES.indexOf(b.klass.id)
        )
      }
      return b.attempts - a.attempts || a.klass.id.localeCompare(b.klass.id)
    })
}
