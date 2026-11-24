import type { BadgeTone } from "../../components/Badge"
import type { EgressAssignment, ProxyOutcome, ReplaceMode } from "../../lib/api/egress"

/** What replacement does and, as plainly, what it never does. Shown wherever the mode is set. */
export const REPLACE_RULE =
  "On failure, the router may replace a dead proxy with another one of the same vendor: after several of its own checks in a row find the proxy itself dead: no answer to the account's upstream or to a neutral host, or its login refused. A proxy that still answers is kept, even one its vendor no longer lists. It never reads an AI provider's answer, a rate limit included, and it never rotates addresses. With no unused healthy proxy the account keeps the one it has and says so."

/** Fine enough for a test cooldown to count down, and cheap over a screen of proxies. */
export const TEST_CLOCK_MS = 5_000

export const REPLACE_OPTIONS: readonly { readonly value: ReplaceMode; readonly label: string }[] = [
  { value: "manual", label: "Keep it" },
  { value: "on-failure", label: "Replace it if it dies" },
]

const OUTCOME: Readonly<
  Record<ProxyOutcome, { readonly label: string; readonly tone: BadgeTone; readonly hint: string }>
> = {
  ok: { label: "ok", tone: "ok", hint: "The proxy opened a tunnel to the account's upstream." },
  auth: { label: "login refused", tone: "danger", hint: "The proxy refused its own credentials." },
  unreachable: {
    label: "unreachable",
    tone: "danger",
    hint: "No connection, or the proxy closed it before answering, whatever it was asked for.",
  },
  timeout: {
    label: "timed out",
    tone: "danger",
    hint: "The proxy did not answer in time, whatever it was asked for.",
  },
  refused: {
    label: "target refused",
    tone: "warn",
    hint: "The proxy is alive: it refused this upstream, or only this upstream stayed silent through it. That is not a dead proxy, so it is never replaced for it.",
  },
  not_listed: {
    label: "not listed",
    tone: "danger",
    hint: "It failed its check, and the vendor's complete list no longer holds it.",
  },
  vendor_invalid: {
    label: "invalid",
    tone: "danger",
    hint: "It failed its check, and the vendor marks it as not working.",
  },
}

const UNCHECKED = {
  label: "not checked",
  tone: "neutral",
  hint: "No check has run against this proxy yet.",
} as const

export function outcomeBadge(outcome: ProxyOutcome | null) {
  return outcome === null ? UNCHECKED : OUTCOME[outcome]
}

/** Why a dead proxy is still in place, or null when there is nothing to explain. */
export function repairNote(
  assignment: Pick<EgressAssignment, "replace" | "health">,
): string | null {
  switch (assignment.health.repair) {
    case "idle":
      return null
    case "cooldown":
      return "Dead, and replaced too recently to be replaced again yet."
    case "no_candidate":
      return "Dead, and no unused healthy proxy of this vendor is left. Buy one or pick another."
    case "vendor_unavailable":
      return "Dead, and the vendor's list could not be read in full, so nothing was replaced."
  }
}

/** What its vendor says against a proxy, and what comes of it. Null when the vendor says nothing. */
export function vendorNote(
  assignment: Pick<EgressAssignment, "listed" | "valid" | "health">,
): string | null {
  const said =
    assignment.listed === false
      ? "The vendor no longer lists it."
      : assignment.valid === false
        ? "The vendor marks it as not working."
        : null
  if (said === null) return null
  return assignment.health.outcome === "ok" ? `${said} It still answers, so it is kept.` : said
}

/** Whether the router can replace this proxy at all: only a vendor's has a sibling to move to. */
export function replaceable(
  assignment: Pick<EgressAssignment, "vendor" | "address">,
  listed: readonly { readonly address: string }[],
): boolean {
  return assignment.vendor !== null || listed.some((proxy) => proxy.address === assignment.address)
}
