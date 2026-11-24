import { request } from "./client"
import type { AccountView } from "./types"

/** Manual leaves a dead proxy in place; on-failure may move the account to another of the vendor's. */
export type ReplaceMode = "manual" | "on-failure"

export type ProxyOutcome =
  | "ok"
  | "auth"
  | "unreachable"
  | "timeout"
  | "refused"
  | "not_listed"
  | "vendor_invalid"

export type ProxyRepair = "idle" | "cooldown" | "no_candidate" | "vendor_unavailable"

/** One proxy the server can name. Its password stays on the server. */
export interface EgressProxyChoice {
  readonly vendor: string
  readonly id: string
  readonly address: string
  readonly location: string
  readonly country: string | null
  readonly city: string | null
  readonly valid: boolean
  readonly lastVerifiedAt: string | null
  readonly accounts: readonly { readonly id: string; readonly label: string }[]
}

export interface EgressVendorState {
  readonly vendor: string
  readonly state: "ok" | "off" | "unavailable"
  /** False when the vendor lists more proxies than the router reads. */
  readonly complete: boolean
  readonly error: { readonly code: string; readonly message: string } | null
}

export interface ProxyHealthView {
  readonly outcome: ProxyOutcome | null
  readonly status: number | null
  readonly latencyMs: number | null
  readonly consecutiveFailures: number
  readonly lastCheckedAt: string | null
  readonly lastOkAt: string | null
  readonly repair: ProxyRepair
  readonly lastSwapAt: string | null
  readonly swaps: number
}

export interface EgressAssignment {
  readonly account: Pick<AccountView, "id" | "label" | "provider" | "status">
  readonly address: string
  /** Null for a proxy typed in by hand. */
  readonly vendor: string | null
  readonly vendorId: string | null
  readonly country: string | null
  readonly replace: ReplaceMode
  /** Null when it cannot be told: a custom proxy, or no complete listing to look in. */
  readonly listed: boolean | null
  /** The vendor's own verdict, null like `listed`. A proxy that still answers is kept regardless. */
  readonly valid: boolean | null
  readonly health: ProxyHealthView
}

export interface EgressOverview {
  /** Whether any proxy vendor is configured on the router. */
  readonly configured: boolean
  readonly vendors: readonly EgressVendorState[]
  readonly proxies: readonly EgressProxyChoice[]
  readonly assigned: readonly EgressAssignment[]
}

export interface ProxyCheck {
  readonly outcome: ProxyOutcome
  readonly status: number | null
  readonly latencyMs: number
  readonly checkedAt: string
  readonly nextAllowedAt: string
}

export type EgressProxyInput = { readonly url: string } | Pick<EgressProxyChoice, "vendor" | "id">

export function fetchEgressOverview(): Promise<EgressOverview> {
  return request<EgressOverview>({ method: "GET", path: "/egress-proxies" })
}

export function setEgressProxy(args: {
  readonly accountId: string
  readonly proxy: (EgressProxyInput & { readonly replace?: ReplaceMode }) | null
}): Promise<AccountView> {
  const path = `/egress-proxies/accounts/${args.accountId}`
  return args.proxy === null
    ? request<AccountView>({ method: "DELETE", path })
    : request<AccountView>({ method: "PATCH", path, body: args.proxy })
}

export function setReplaceMode(args: {
  readonly accountId: string
  readonly replace: ReplaceMode
}): Promise<AccountView> {
  return request<AccountView>({
    method: "PATCH",
    path: `/egress-proxies/accounts/${args.accountId}/replace`,
    body: { replace: args.replace },
  })
}

/**
 * Probes a proxy before it is set. Nothing is stored. `accountId` makes it reach for that account's
 * upstream, the one this proxy would have to let through.
 */
export function testProxy(
  proxy: EgressProxyInput & { readonly accountId?: string },
): Promise<ProxyCheck> {
  return request<ProxyCheck>({ method: "POST", path: "/egress-proxies/test", body: proxy })
}

/** Probes the proxy an account leaves through, towards that account's own upstream. */
export function testAccountProxy(accountId: string): Promise<ProxyCheck> {
  return request<ProxyCheck>({
    method: "POST",
    path: `/egress-proxies/accounts/${accountId}/test`,
  })
}
