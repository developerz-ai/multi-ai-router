import { createAccountEgressHealthRepository, type Database } from "@multi-ai-router/db"
import type { EgressProxyEnv, WebshareEnv } from "../../../config/egress-proxy"
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
  env: { readonly webshare: WebshareEnv; readonly egressProxy: EgressProxyEnv },
  fetch?: WebshareDeps["fetch"],
): readonly ProxyVendor[] {
  const bounds = {
    maxPages: env.egressProxy.vendorMaxPages,
    maxBytes: env.egressProxy.vendorMaxBytes,
  }
  return [
    createWebshareVendor({ ...env.webshare, ...bounds, ...(fetch === undefined ? {} : { fetch }) }),
  ]
}

export interface EgressFromEnvDeps
  extends Pick<EgressServiceDeps, "accounts" | "cipher" | "audit" | "now"> {
  readonly database: Database
  readonly coherence: { refreshCatalog(): Promise<void> }
  readonly webshare: WebshareEnv
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
    vendors: vendorsFromEnv({ webshare: deps.webshare, egressProxy: env.egressProxy }),
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
