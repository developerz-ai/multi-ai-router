import type {
  AccountEgressHealthRepository,
  AccountRepository,
  AccountRow,
  StoredEgressProxy,
} from "@multi-ai-router/db"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../../admin/audit"
import { type AdminResult, conflict, invalid, notFound, ok, tooSoon } from "../../admin/result"
import type { CredentialCipher } from "../../crypto/cipher"
import { type AccountView, toAccountView } from "../view"
import {
  needsVendor,
  proxyAllowed,
  type ReplaceModeBody,
  resolveProxy,
  type SetEgressProxyBody,
  type TestEgressProxyBody,
  toStored,
  upstreamTarget,
} from "./assignment"
import { NEUTRAL_TARGET, type ProbeResult, type ProxyProbe } from "./probe"
import { createEgressSweep, type EgressSweepInput, type EgressSweepResult } from "./repair"
import { listOnce, type ProxyVendor, vendorFailure } from "./vendor"
import { assignmentOf, type EgressOverview, toOverview } from "./view"

/**
 * One egress proxy per account, or none. The operator names it, and it stays until they change it
 * or, for an account they marked `on-failure`, until it is dead (`repair.ts`). Nothing picks an
 * address per request, and nothing an AI provider answered changes one.
 */

export interface ProxyCheck {
  readonly outcome: ProbeResult["outcome"]
  readonly status: number | null
  readonly latencyMs: number
  readonly checkedAt: string
  readonly nextAllowedAt: string
}

export interface EgressProxyService {
  list(): Promise<AdminResult<EgressOverview>>
  set(accountId: string, body: SetEgressProxyBody): Promise<AdminResult<AccountView>>
  setReplace(accountId: string, body: ReplaceModeBody): Promise<AdminResult<AccountView>>
  clear(accountId: string): Promise<AdminResult<AccountView>>
  /** Tries a proxy nothing is assigned yet. Stores nothing. */
  test(body: TestEgressProxyBody): Promise<AdminResult<ProxyCheck>>
  /** Tries the account's own proxy. Its failure is shown, and never counted toward a swap. */
  testAccount(accountId: string): Promise<AdminResult<ProxyCheck>>
  /** The scheduled check, for `egress_proxy_check`. */
  sweep(input: EgressSweepInput): Promise<EgressSweepResult>
}

export interface EgressServiceDeps {
  readonly accounts: Pick<
    AccountRepository,
    | "findById"
    | "assignEgressProxy"
    | "listWithEgressProxy"
    | "listDueEgressChecks"
    | "listHeldEgressProxies"
    | "swapEgressProxy"
  >
  readonly health: AccountEgressHealthRepository
  readonly cipher: Pick<CredentialCipher, "encrypt" | "decrypt">
  readonly audit: AuditRecorder
  readonly now: () => Date
  readonly vendors: readonly ProxyVendor[]
  readonly probe: ProxyProbe
  /** The router's warm catalog, refreshed after a write so the next request already leaves through it. */
  readonly refreshCatalog: () => Promise<void>
  readonly testCooldownSeconds: number
  readonly policy: {
    readonly batchSize: number
    readonly failureThreshold: number
    readonly swapCooldownMs: number
  }
}

/** A lost compare-and-swap is re-read once: a second loss is another writer, not bad luck. */
const REPLACE_ATTEMPTS = 2

export function createEgressService(deps: EgressServiceDeps): EgressProxyService {
  const tested = new Map<string, number>()
  const cooldownMs = deps.testCooldownSeconds * 1_000

  const load = async (id: string): Promise<AdminResult<AccountRow>> => {
    const row = await deps.accounts.findById(id)
    return row === undefined ? notFound(`no account with id "${id}"`) : ok(row)
  }

  const written = async (row: AccountRow): Promise<AdminResult<AccountView>> => {
    await deps.refreshCatalog()
    await deps.audit.record({
      kind: AUDIT_KINDS.accountUpdated,
      subjectType: AUDIT_SUBJECTS.account,
      subjectId: row.id,
      // The address only: the userinfo in the URL is a credential.
      detail: {
        label: row.label,
        fields: ["egressProxy"],
        egressProxy: row.egressProxy?.address ?? null,
        replace: row.egressProxy?.replace ?? "manual",
      },
    })
    return ok(toAccountView(row))
  }

  const assign = async (
    id: string,
    next: StoredEgressProxy | null,
    inheritReplace: boolean,
  ): Promise<AdminResult<AccountView>> => {
    const row = await deps.accounts.assignEgressProxy({
      id,
      next,
      inheritReplace,
      now: deps.now(),
    })
    return row === undefined ? notFound(`no account with id "${id}"`) : written(row)
  }

  /** Who this proxy is in its vendor's list. A row stored before 0059 is matched by its address. */
  const identified = async (proxy: StoredEgressProxy): Promise<AdminResult<StoredEgressProxy>> => {
    if (proxy.vendorId !== undefined) return ok(proxy)
    const listing = listOnce(deps.vendors)
    for (const vendor of deps.vendors.filter((candidate) => candidate.configured())) {
      const read = await listing(vendor.id)
      if (!read.ok) return vendorFailure(vendor.id, read)
      const match = read.proxies.find((candidate) => candidate.address === proxy.address)
      if (match !== undefined)
        return ok({ ...proxy, vendor: match.vendor, vendorId: match.id, country: match.country })
    }
    return needsVendor()
  }

  /** One test per proxy per cooldown: each opens a connection through somebody's paid proxy. */
  const runTest = async (
    key: string,
    url: string,
    target: string,
  ): Promise<AdminResult<ProxyCheck>> => {
    const at = deps.now().getTime()
    for (const [held, since] of tested) if (at - since >= cooldownMs) tested.delete(held)
    const previous = tested.get(key)
    if (previous !== undefined) {
      const wait = Math.ceil((previous + cooldownMs - at) / 1_000)
      return tooSoon(
        `this proxy was tested moments ago — test it again in ${wait}s`,
        "proxy_test_cooldown",
        wait,
      )
    }
    if (cooldownMs > 0) tested.set(key, at)
    const result = await deps.probe(url, target)
    return ok({
      ...result,
      checkedAt: new Date(at).toISOString(),
      nextAllowedAt: new Date(at + cooldownMs).toISOString(),
    })
  }

  return {
    list: async () => {
      const listing = listOnce(deps.vendors)
      const [accounts, ...listings] = await Promise.all([
        deps.accounts.listWithEgressProxy(),
        ...deps.vendors.map(async ({ id }) => [id, await listing(id)] as const),
      ])
      const health = await deps.health.listForAccounts(accounts.map((row) => row.id))
      return ok(
        toOverview({
          vendors: deps.vendors,
          listings: new Map(listings),
          accounts,
          health: new Map(health.map((row) => [row.accountId, row])),
        }),
      )
    },

    set: async (id, body) => {
      const account = await load(id)
      if (!account.ok) return account
      const allowed = proxyAllowed(account.value)
      if (!allowed.ok) return allowed
      const proxy = await resolveProxy(deps.vendors, body)
      if (!proxy.ok) return proxy
      const next = toStored(deps.cipher, proxy.value, body.replace)
      if (!next.ok) return next
      // Unstated, the mode survives a change of proxy wherever the new one can carry it, as the row
      // has it when it is written: the operator may have changed it while the vendor was asked.
      return assign(id, next.value, body.replace === undefined && proxy.value.from !== null)
    },

    setReplace: async (id, body) => {
      for (let attempt = 0; attempt < REPLACE_ATTEMPTS; attempt++) {
        const account = await load(id)
        if (!account.ok) return account
        const held = account.value.egressProxy
        if (held === null)
          return invalid(
            `account "${account.value.label}" has no egress proxy`,
            "egress_proxy_none",
          )
        const target = body.replace === "manual" ? ok(held) : await identified(held)
        if (!target.ok) return target
        const row = await deps.accounts.swapEgressProxy({
          id,
          expectedSealed: held.sealed,
          next: { ...target.value, replace: body.replace },
          exclusive: false,
          actor: "operator",
          now: deps.now(),
        })
        if (row !== undefined) return written(row)
      }
      return conflict(
        "the account's proxy changed while this was saved — reload and try again",
        "egress_proxy_changed",
      )
    },

    clear: async (id) => {
      const account = await load(id)
      return account.ok ? assign(id, null, false) : account
    },

    test: async (body) => {
      const proxy = await resolveProxy(deps.vendors, body)
      if (!proxy.ok) return proxy
      if (body.accountId === undefined)
        return runTest(proxy.value.address, proxy.value.url, NEUTRAL_TARGET)
      const account = await load(body.accountId)
      if (!account.ok) return account
      return runTest(proxy.value.address, proxy.value.url, upstreamTarget(account.value))
    },

    testAccount: async (id) => {
      const account = await load(id)
      if (!account.ok) return account
      const held = account.value.egressProxy
      if (held === null)
        return invalid(`account "${account.value.label}" has no egress proxy`, "egress_proxy_none")
      const checked = await runTest(
        held.address,
        deps.cipher.decrypt(held.sealed),
        upstreamTarget(account.value),
      )
      if (!checked.ok) return checked
      const { outcome, status, latencyMs, checkedAt } = checked.value
      await deps.health.recordCheck({
        accountId: id,
        assignment: assignmentOf(held),
        outcome,
        status,
        latencyMs,
        countsAsFailure: false,
        checkedAt: new Date(checkedAt),
      })
      return checked
    },

    sweep: createEgressSweep(deps),
  }
}
