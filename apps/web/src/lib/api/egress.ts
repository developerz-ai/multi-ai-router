import { request } from "./client"
import type { AccountView } from "./types"

/** One proxy the server can name. Its password stays on the server. */
export interface EgressProxyChoice {
  readonly vendor: "webshare"
  readonly id: string
  readonly address: string
  readonly location: string
  readonly valid: boolean
}

export interface EgressProxyList {
  /** Whether `WEBSHARE_API_KEY` is set on the router. */
  readonly configured: boolean
  readonly proxies: readonly EgressProxyChoice[]
}

export type EgressProxyInput = { readonly url: string } | Pick<EgressProxyChoice, "vendor" | "id">

export function listEgressProxies(): Promise<EgressProxyList> {
  return request<EgressProxyList>({ method: "GET", path: "/egress-proxies" })
}

export function setEgressProxy(args: {
  readonly accountId: string
  readonly proxy: EgressProxyInput | null
}): Promise<AccountView> {
  const path = `/egress-proxies/accounts/${args.accountId}`
  return args.proxy === null
    ? request<AccountView>({ method: "DELETE", path })
    : request<AccountView>({ method: "PATCH", path, body: args.proxy })
}
