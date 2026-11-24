import type { EgressAssignment, EgressOverview, ProxyHealthView } from "../../src/lib/api/egress"

export const HEALTHY: ProxyHealthView = {
  outcome: "ok",
  status: 200,
  latencyMs: 41,
  consecutiveFailures: 0,
  lastCheckedAt: "2026-11-23T00:00:00Z",
  lastOkAt: "2026-11-23T00:00:00Z",
  repair: "idle",
  lastSwapAt: null,
  swaps: 0,
}

export function assignment(
  options: Partial<EgressAssignment> & {
    readonly id?: string
    readonly label?: string
    readonly healthOf?: Partial<ProxyHealthView>
  } = {},
): EgressAssignment {
  const { id = "a", label = "or-main", healthOf, ...rest } = options
  return {
    account: { id, label, provider: "openrouter", status: "active" },
    address: "203.0.113.7:6754",
    vendor: "webshare",
    vendorId: "d-1",
    country: "US",
    replace: "manual",
    listed: true,
    valid: true,
    health: { ...HEALTHY, ...healthOf },
    ...rest,
  }
}

export function overview(overrides: Partial<EgressOverview> = {}): EgressOverview {
  return {
    configured: true,
    vendors: [{ vendor: "webshare", state: "ok", complete: true, error: null }],
    proxies: [
      {
        vendor: "webshare",
        id: "d-1",
        address: "203.0.113.7:6754",
        location: "Buffalo, US",
        country: "US",
        city: "Buffalo",
        valid: true,
        lastVerifiedAt: "2026-11-23T00:00:00Z",
        accounts: [],
      },
    ],
    assigned: [],
    ...overrides,
  }
}
