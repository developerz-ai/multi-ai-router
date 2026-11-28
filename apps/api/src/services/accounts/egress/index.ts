import { createAccountEgressHealthRepository, type Database } from "@multi-ai-router/db"
import type {
  DecodoEnv,
  EgressProxyEnv,
  IproyalEnv,
  WebshareEnv,
} from "../../../config/egress-proxy"
import { createDecodoVendor } from "./decodo"
import { createIproyalVendor } from "./iproyal"
import { createProxyProbe, withNeutralControl } from "./probe"
import { createEgressService, type EgressProxyService, type EgressServiceDeps } from "./service"
import type { ProxyVendor } from "./vendor"
import { createWebshareVendor, type WebshareDeps } from "./webshare"

export {
  replaceModeBody,
  type SetEgressProxyBody,
  setEgressProxyBody,
  testEgressProxyBody,
} from "./assignment"
export type { EgressSweepInput, EgressSweepResult } from "./repair"
export {
  createEgressService,
  type EgressProxyService,
  type EgressServiceDeps,
  type ProxyCheck,
} from "./service"
export type { EgressOverview, ProxyHealthView, ReplaceMode } from "./view"

/** The vendor registry: a second vendor is a line here. */
export function vendorsFromEnv(
  env: {
    readonly webshare: WebshareEnv
    readonly iproyal: IproyalEnv
    readonly decodo: DecodoEnv
    readonly egressProxy: EgressProxyEnv
  },
  fetch?: WebshareDeps["fetch"],
): readonly ProxyVendor[] {
  const bounds = {
    maxPages: env.egressProxy.vendorMaxPages,
    maxBytes: env.egressProxy.vendorMaxBytes,
  }
  // The backconnect vendors page once and never paginate, so they take only the byte cap.
  const capped = { maxBytes: env.egressProxy.vendorMaxBytes }
  const shared = fetch === undefined ? {} : { fetch }
  return [
    createWebshareVendor({ ...env.webshare, ...bounds, ...shared }),
    createIproyalVendor({ ...env.iproyal, ...capped, ...shared }),
    createDecodoVendor({ ...env.decodo, ...capped, ...shared }),
  ]
}

export interface EgressFromEnvDeps
  extends Pick<EgressServiceDeps, "accounts" | "cipher" | "audit" | "now"> {
  readonly database: Database
  readonly coherence: { refreshCatalog(): Promise<void> }
  readonly webshare: WebshareEnv
  readonly iproyal: IproyalEnv
  readonly decodo: DecodoEnv
  readonly env: {
    readonly egressProxy: EgressProxyEnv
    readonly accountTestNowCooldownSeconds: number
  }
}

export function createEgressProxyService(deps: EgressFromEnvDeps): EgressProxyService {
  const { env, accounts, cipher, audit, now } = deps
  return createEgressService({
    accounts,
    cipher,
    audit,
    now,
    health: createAccountEgressHealthRepository(deps.database),
    vendors: vendorsFromEnv({
      webshare: deps.webshare,
      iproyal: deps.iproyal,
      decodo: deps.decodo,
      egressProxy: env.egressProxy,
    }),
    probe: withNeutralControl(createProxyProbe(env.egressProxy.checkTimeoutMs)),
    refreshCatalog: () => deps.coherence.refreshCatalog(),
    testCooldownSeconds: env.accountTestNowCooldownSeconds,
    policy: {
      batchSize: env.egressProxy.checkBatchSize,
      failureThreshold: env.egressProxy.failureThreshold,
      swapCooldownMs: env.egressProxy.swapCooldownMinutes * 60_000,
    },
  })
}
