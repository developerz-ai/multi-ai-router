import type { EgressProxyOutcome, EgressRepairState, StoredEgressProxy } from "@multi-ai-router/db"
import type { VendorListing, VendorProxy } from "./vendor"

/** How many candidates one repair may probe. */
export const MAX_CANDIDATES = 3

/** The outcomes that say the proxy itself is dead. `refused` is a live proxy declining a target. */
const PROXY_FAILURES: ReadonlySet<EgressProxyOutcome> = new Set([
  "auth",
  "unreachable",
  "timeout",
  "not_listed",
  "vendor_invalid",
])

export function isProxyFailure(outcome: EgressProxyOutcome): boolean {
  return PROXY_FAILURES.has(outcome)
}

/**
 * What the vendor's own list says about an assigned proxy, or `null` when it says nothing. A listing
 * that failed or stopped at its page cap is never evidence of absence.
 */
export function vendorVerdict(
  proxy: StoredEgressProxy,
  listing: VendorListing | null,
): "not_listed" | "vendor_invalid" | null {
  if (proxy.vendorId === undefined || listing === null || !listing.ok) return null
  const held = listing.proxies.find((candidate) => candidate.id === proxy.vendorId)
  if (held === undefined) return listing.complete ? "not_listed" : null
  return held.valid ? null : "vendor_invalid"
}

/**
 * What a check records. A proxy that answered is not dead whatever its vendor lists, so the vendor's
 * word only names the failure of one that did not; the overview shows it either way.
 */
export function checkedOutcome(
  probed: EgressProxyOutcome,
  vendor: "not_listed" | "vendor_invalid" | null,
): EgressProxyOutcome {
  return vendor !== null && isProxyFailure(probed) ? vendor : probed
}

export interface RepairFacts {
  readonly proxy: StoredEgressProxy
  /** The proxy URL as it is sealed now. */
  readonly url: string
  readonly consecutiveFailures: number
  readonly lastSwapAt: Date | null
  readonly listing: VendorListing
  /** What every other account leaves through. */
  readonly taken: { readonly addresses: ReadonlySet<string>; readonly ids: ReadonlySet<string> }
  readonly now: Date
  readonly threshold: number
  readonly cooldownMs: number
  /** The vendor's current copy of this proxy was already probed, and it is dead too. */
  readonly resealFailed?: boolean
}

export type RepairStep =
  | { readonly kind: "none" }
  | { readonly kind: "hold"; readonly repair: Exclude<EgressRepairState, "idle"> }
  /** The same proxy at the same address under new credentials: not a swap, and free of its cooldown. */
  | { readonly kind: "reseal"; readonly proxy: VendorProxy }
  | { readonly kind: "swap"; readonly candidates: readonly VendorProxy[] }

/**
 * Whether a dead proxy may be repaired, and with what. It reads proxy-level facts only: no field
 * here can carry an AI provider's answer, so no status of theirs can move an account to another
 * address. The order is fixed, so the same facts always pick the same proxy.
 */
export function decideRepair(facts: RepairFacts): RepairStep {
  const { proxy, listing } = facts
  if (proxy.replace !== "on-failure" || proxy.vendorId === undefined) return { kind: "none" }
  if (facts.consecutiveFailures < facts.threshold) return { kind: "none" }

  if (listing.ok && facts.resealFailed !== true) {
    const current = listing.proxies.find((candidate) => candidate.id === proxy.vendorId)
    const sameAddress = current?.address === proxy.address
    if (current?.valid === true && sameAddress && current.url !== facts.url) {
      return { kind: "reseal", proxy: current }
    }
  }
  if (
    facts.lastSwapAt !== null &&
    facts.now.getTime() - facts.lastSwapAt.getTime() < facts.cooldownMs
  ) {
    return { kind: "hold", repair: "cooldown" }
  }
  if (!listing.ok || !listing.complete) return { kind: "hold", repair: "vendor_unavailable" }

  const candidates = listing.proxies
    .filter(
      (candidate) =>
        candidate.valid &&
        // Also what keeps the same id out, unless its vendor gave it a new address: that is a move
        // like any other, and the first choice.
        candidate.address !== proxy.address &&
        !facts.taken.ids.has(`${candidate.vendor}/${candidate.id}`) &&
        !facts.taken.addresses.has(candidate.address),
    )
    .sort(
      (a, b) =>
        Number(b.id === proxy.vendorId) - Number(a.id === proxy.vendorId) ||
        Number(b.country === proxy.country) - Number(a.country === proxy.country) ||
        (a.id < b.id ? -1 : 1),
    )
    .slice(0, MAX_CANDIDATES)
  return candidates.length === 0
    ? { kind: "hold", repair: "no_candidate" }
    : { kind: "swap", candidates }
}
