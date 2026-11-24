import {
  NEUTRAL_TARGET,
  type ProbeResult,
  withNeutralControl,
} from "../../../src/services/accounts/egress/probe"
import { createEgressService } from "../../../src/services/accounts/egress/service"
import type {
  ProxyVendor,
  VendorListing,
  VendorProxy,
} from "../../../src/services/accounts/egress/vendor"
import { createAuditRecorder } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { memoryEgress } from "../../support/memory-egress"
import { createMemoryStore } from "../../support/memory-store"
import { silentLogger } from "../../support/silent-logger"

export const PASSWORD = "webshare-pw"
export const KEY = "webshare-api-key"
export const NOW = new Date("2026-11-23T21:00:00.000Z")

export function vendorProxy(id: string, overrides: Partial<VendorProxy> = {}): VendorProxy {
  const address = overrides.address ?? `203.0.113.${id.replace(/\D/g, "")}:6754`
  return {
    vendor: "webshare",
    id,
    address,
    country: "US",
    city: "Buffalo",
    valid: true,
    lastVerifiedAt: null,
    url: `http://user:${PASSWORD}@${address}`,
    ...overrides,
  }
}

export const listed = (...proxies: VendorProxy[]): VendorListing => ({
  ok: true,
  proxies,
  complete: true,
})

/** A whole egress service over memory, with a scripted vendor and a scripted proxy fleet. */
export function egressHarness(
  options: {
    listing?: VendorListing
    /** Addresses that answer CONNECT, or another outcome; anything unnamed is unreachable. */
    alive?: readonly string[]
    outcomes?: Record<string, ProbeResult["outcome"]>
    cooldownSeconds?: number
    batchSize?: number
  } = {},
) {
  const store = createMemoryStore()
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
  const egress = memoryEgress(store.rows.accounts)
  const clock = { now: NOW }
  const world = {
    listing: options.listing ?? { ok: false as const, code: "off" as const },
    alive: new Set(options.alive ?? []),
    /** Alive, and dropped by the account's upstream. */
    blocked: new Set<string>(),
    outcomes: { ...options.outcomes },
    /** The only URL an address accepts; any other is its `407`. */
    accepts: {},
    listings: 0,
    onList: undefined as (() => void | Promise<void>) | undefined,
    probes: [] as { address: string; target: string; url: string }[],
    onProbe: undefined as ((address: string) => void | Promise<void>) | undefined,
    refreshed: 0,
  } as {
    listing: VendorListing
    alive: Set<string>
    blocked: Set<string>
    outcomes: Record<string, ProbeResult["outcome"]>
    accepts: Record<string, string>
    listings: number
    onList: (() => void | Promise<void>) | undefined
    probes: { address: string; target: string; url: string }[]
    onProbe: ((address: string) => void | Promise<void>) | undefined
    refreshed: number
  }
  const vendor: ProxyVendor = {
    id: "webshare",
    configured: () => world.listing.ok || world.listing.code !== "off",
    list: async () => {
      world.listings += 1
      await world.onList?.()
      return world.listing
    },
  }
  const lines: { msg: string; fields: Record<string, unknown> }[] = []
  const line = (msg: string, fields: Record<string, unknown> = {}) =>
    void lines.push({ msg, fields })
  const service = createEgressService({
    accounts: {
      ...store.accounts,
      ...egress.methods,
      // What a read answered does not follow the row, as a query's does not.
      findById: async (id) => structuredClone(await store.accounts.findById(id)),
    },
    health: egress.repository,
    cipher,
    audit: createAuditRecorder(store.audit, silentLogger()),
    now: () => clock.now,
    vendors: [vendor],
    // Under the real control: a proxy silent to its upstream is asked for a neutral host too.
    probe: withNeutralControl(async (url, target) => {
      const address = new URL(url).host
      world.probes.push({ address, target, url })
      await world.onProbe?.(address)
      const blocked = target !== NEUTRAL_TARGET && world.blocked.has(address)
      const accepted = world.accepts[address]
      if (accepted !== undefined && accepted !== url)
        return { outcome: "auth", status: 407, latencyMs: 12 }
      const outcome = blocked
        ? "timeout"
        : (world.outcomes[address] ?? (world.alive.has(address) ? "ok" : "unreachable"))
      return { outcome, status: outcome === "ok" ? 200 : null, latencyMs: 12 }
    }),
    refreshCatalog: async () => {
      world.refreshed += 1
    },
    testCooldownSeconds: options.cooldownSeconds ?? 60,
    policy: {
      batchSize: options.batchSize ?? 50,
      failureThreshold: 3,
      swapCooldownMs: 6 * 3_600_000,
    },
  })
  const add = (provider: "openrouter" | "anthropic-oauth" | "openai-oauth" = "openrouter") =>
    store.accounts.create({ label: provider, provider, authMaterial: "sealed" })
  const proxyOf = async (id: string) => (await store.accounts.findById(id))?.egressProxy ?? null
  const sweep = (minutes = 5) => {
    clock.now = new Date(clock.now.getTime() + minutes * 60_000)
    return service.sweep({
      now: clock.now,
      logger: { info: line, warn: line },
      signal: new AbortController().signal,
    })
  }
  /** Everything an operator or a log could see. */
  const visible = async () =>
    JSON.stringify([
      await service.list(),
      store.rows.audit,
      lines,
      await service.test({ url: "http://u:p@h.test:1" }),
    ])
  return { service, store, cipher, egress, world, clock, lines, add, proxyOf, sweep, visible }
}
