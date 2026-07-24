import type { AccountStatus } from "@multi-ai-router/core"

// Account status → presentation. Pure: no DOM, no clock, no fetch.
//
// The status vocabulary itself is **not** defined here — it comes from
// `@multi-ai-router/core`, the single definition shared with the API and the
// database. This module owns only how each status looks and reads.
//
// The load-bearing rule is that `cooling_down` and `exhausted` never share a
// token or a phrasing. One is a clock the operator waits out; the other needs a
// human with a credit card. Rendering them the same way is the bug this module
// exists to prevent.

/** A semantic token name, always resolved through `var(...)` at the call site. */
export type StatusToken = "--ok" | "--warn" | "--danger" | "--text-muted"

/** Solid vs. hollow dot — keeps two `--danger` statuses distinguishable. */
export type StatusFill = "solid" | "hollow"

export interface StatusPresentation {
  readonly token: StatusToken
  readonly fill: StatusFill
  readonly label: string
  /** One line an operator can act on. No jargon, no error codes. */
  readonly hint: string
}

// Keyed by core's union, so a status added upstream fails this build until it
// has a presentation. That is the drift gate, not a convention.
const PRESENTATION: Readonly<Record<AccountStatus, StatusPresentation>> = {
  active: {
    token: "--ok",
    fill: "solid",
    label: "Active",
    hint: "Eligible for routing.",
  },
  cooling_down: {
    token: "--warn",
    fill: "solid",
    label: "Cooling down",
    hint: "Rate limited. Comes back on its own when the window resets.",
  },
  exhausted: {
    token: "--danger",
    fill: "solid",
    label: "Exhausted",
    hint: "Out of credits. Needs top-up — there is no reset to wait for.",
  },
  needs_reauth: {
    token: "--danger",
    fill: "hollow",
    label: "Needs reauth",
    hint: "Credentials can no longer be renewed. Reconnect the account.",
  },
  disabled: {
    token: "--text-muted",
    fill: "solid",
    label: "Disabled",
    hint: "Turned off by the operator. Excluded from every candidate set.",
  },
}

/**
 * Order for status legends and lists — **presentation data, not a second
 * definition of the domain.** It runs the lifecycle an operator reads it in
 * (healthy → temporary → permanent → switched off), which is deliberately not
 * core's declaration order.
 *
 * Two things keep it honest: `satisfies` rejects any value core does not have,
 * and a unit test asserts it is a permutation of `AccountStatus.options`, so a
 * status added to core cannot be silently missed here.
 */
export const STATUS_DISPLAY_ORDER = [
  "active",
  "cooling_down",
  "exhausted",
  "needs_reauth",
  "disabled",
] as const satisfies readonly AccountStatus[]

export function statusPresentation(status: AccountStatus): StatusPresentation {
  return PRESENTATION[status]
}

export function statusToken(status: AccountStatus): StatusToken {
  return PRESENTATION[status].token
}

export function statusLabel(status: AccountStatus): string {
  return PRESENTATION[status].label
}

/** Only `active` accounts enter a candidate set. */
export function isRoutable(status: AccountStatus): boolean {
  return status === "active"
}

/** True when no clock will fix it — drives the dashboard's red banner. */
export function needsOperator(status: AccountStatus): boolean {
  return status === "exhausted" || status === "needs_reauth"
}

/** True when a reset countdown is meaningful for this status. */
export function hasReset(status: AccountStatus): boolean {
  return status === "cooling_down"
}
