import { createHash } from "node:crypto"
import type { AccountStatus, ProviderId } from "@multi-ai-router/core"
import type {
  EgressAccountRow,
  EgressHealthRow,
  EgressProxyOutcome,
  EgressRepairState,
  StoredEgressProxy,
} from "@multi-ai-router/db"
import { type ProxyVendor, type VendorListing, type VendorProxy, vendorSentence } from "./vendor"

export type ReplaceMode = "manual" | "on-failure"

export interface ProxyHealthView {
  readonly outcome: EgressProxyOutcome | null
  readonly status: number | null
  readonly latencyMs: number | null
  readonly consecutiveFailures: number
  readonly lastCheckedAt: string | null
  readonly lastOkAt: string | null
  readonly repair: EgressRepairState
  readonly lastSwapAt: string | null
  readonly swaps: number
}

export interface EgressOverview {
  /** Whether any vendor has a key. */
  readonly configured: boolean
  readonly vendors: readonly {
    readonly vendor: string
    readonly state: "ok" | "off" | "unavailable"
    readonly complete: boolean
    readonly error: { readonly code: string; readonly message: string } | null
  }[]
  readonly proxies: readonly (Omit<VendorProxy, "url"> & {
    readonly location: string
    readonly accounts: readonly { readonly id: string; readonly label: string }[]
  })[]
  readonly assigned: readonly {
    readonly account: {
      readonly id: string
      readonly label: string
      readonly provider: ProviderId
      readonly status: AccountStatus
    }
    readonly address: string
    readonly vendor: string | null
    readonly vendorId: string | null
    readonly country: string | null
    readonly replace: ReplaceMode
    /** `null`: a custom proxy, or a listing that failed or stopped short. */
    readonly listed: boolean | null
    /** The vendor's own verdict on it; `null` as for `listed`. A proxy that answers is kept anyway. */
    readonly valid: boolean | null
    readonly health: ProxyHealthView
  }[]
}

/** Which proxy a health row is about. Assigning another one makes the row stale without a write. */
export function assignmentOf(proxy: Pick<StoredEgressProxy, "sealed">): string {
  return createHash("sha256").update(proxy.sealed, "utf8").digest("hex")
}

/** Health of the proxy the account has *now*. The swap clock belongs to the account and survives. */
export function currentHealth(
  proxy: Pick<StoredEgressProxy, "sealed">,
  row: EgressHealthRow | undefined,
): Omit<EgressHealthRow, "accountId"> {
  const assignment = assignmentOf(proxy)
  if (row !== undefined && row.assignment === assignment) return row
  return {
    assignment,
    lastOutcome: null,
    lastStatus: null,
    latencyMs: null,
    consecutiveFailures: 0,
    lastCheckedAt: null,
    lastOkAt: null,
    repair: "idle",
    lastSwapAt: row?.lastSwapAt ?? null,
    swaps: row?.swaps ?? 0,
  }
}

export function toOverview(input: {
  readonly vendors: readonly ProxyVendor[]
  readonly listings: ReadonlyMap<string, VendorListing>
  readonly accounts: readonly EgressAccountRow[]
  readonly health: ReadonlyMap<string, EgressHealthRow>
}): EgressOverview {
  const inventory = new Map<string, ReadonlyMap<string, VendorProxy>>()
  for (const [vendor, listing] of input.listings)
    if (listing.ok)
      inventory.set(vendor, new Map(listing.proxies.map((proxy) => [proxy.id, proxy])))
  // A row stored before identities were is matched by its address.
  const holders = Map.groupBy(input.accounts, ({ egressProxy: held }) =>
    held.vendorId === undefined ? held.address : identity(held.vendor, held.vendorId),
  )
  const proxies = [...input.listings.values()].flatMap((listing) =>
    listing.ok ? listing.proxies : [],
  )
  return {
    configured: input.vendors.some((vendor) => vendor.configured()),
    vendors: input.vendors.map(({ id }) => {
      const listing = input.listings.get(id) ?? { ok: false, code: "off" as const }
      if (listing.ok) return { vendor: id, state: "ok", complete: listing.complete, error: null }
      if (listing.code === "off") return { vendor: id, state: "off", complete: false, error: null }
      const error = { code: listing.code, message: vendorSentence(id, listing) }
      return { vendor: id, state: "unavailable", complete: false, error }
    }),
    proxies: proxies.map(({ url: _url, ...shown }) => ({
      ...shown,
      location: [shown.city, shown.country].filter(Boolean).join(", "),
      accounts: [identity(shown.vendor, shown.id), shown.address]
        .flatMap((key) => holders.get(key) ?? [])
        .map(({ id, label }) => ({ id, label })),
    })),
    assigned: input.accounts.map((row) => {
      const { egressProxy: proxy } = row
      const health = currentHealth(proxy, input.health.get(row.id))
      return {
        account: { id: row.id, label: row.label, provider: row.provider, status: row.status },
        address: proxy.address,
        vendor: proxy.vendor ?? null,
        vendorId: proxy.vendorId ?? null,
        country: proxy.country ?? null,
        replace: proxy.replace ?? "manual",
        ...vendorWord(proxy, input.listings, inventory),
        health: {
          outcome: health.lastOutcome,
          status: health.lastStatus,
          latencyMs: health.latencyMs,
          consecutiveFailures: health.consecutiveFailures,
          lastCheckedAt: health.lastCheckedAt?.toISOString() ?? null,
          lastOkAt: health.lastOkAt?.toISOString() ?? null,
          repair: health.repair,
          lastSwapAt: health.lastSwapAt?.toISOString() ?? null,
          swaps: health.swaps,
        },
      }
    }),
  }
}

/** Never an address: no `host:port` holds a slash. */
function identity(vendor: string | undefined, id: string): string {
  return `${vendor}/${id}`
}

function vendorWord(
  proxy: StoredEgressProxy,
  listings: ReadonlyMap<string, VendorListing>,
  inventory: ReadonlyMap<string, ReadonlyMap<string, VendorProxy>>,
): { listed: boolean | null; valid: boolean | null } {
  const silent = { listed: null, valid: null }
  if (proxy.vendor === undefined || proxy.vendorId === undefined) return silent
  const listing = listings.get(proxy.vendor)
  if (listing === undefined || !listing.ok) return silent
  const held = inventory.get(proxy.vendor)?.get(proxy.vendorId)
  if (held !== undefined) return { listed: true, valid: held.valid }
  return listing.complete ? { listed: false, valid: null } : silent
}
