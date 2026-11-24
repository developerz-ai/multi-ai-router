import type { AccountRow, StoredEgressProxy } from "@multi-ai-router/db"
import { z } from "zod"
import { type AdminResult, invalid, ok } from "../../admin/result"
import type { CredentialCipher } from "../../crypto/cipher"
import { describeProvider } from "../providers"
import { checkProxiedPlaintext, upstreamBase } from "../rules"
import type { ProbeTarget } from "./probe"
import { NEUTRAL_TARGET } from "./probe"
import { listOnce, type ProxyVendor, type VendorProxy, vendorFailure } from "./vendor"
import type { ReplaceMode } from "./view"

const PROXY_URL = z.url({ protocol: /^https?$/ }).max(2048)
const CHOICE = { vendor: z.string().trim().min(1).max(32), id: z.string().trim().min(1).max(64) }
const replace = z.enum(["manual", "on-failure"])

export const setEgressProxyBody = z.union([
  z.object({ url: PROXY_URL, replace: replace.optional() }).strict(),
  z.object({ ...CHOICE, replace: replace.optional() }).strict(),
])
export type SetEgressProxyBody = z.infer<typeof setEgressProxyBody>

export const replaceModeBody = z.object({ replace }).strict()
export type ReplaceModeBody = z.infer<typeof replaceModeBody>

const accountId = z.uuid().optional()
/** A proxy to try before anything is assigned; `accountId` names whose upstream to reach. */
export const testEgressProxyBody = z.union([
  z.object({ url: PROXY_URL, accountId }).strict(),
  z.object({ ...CHOICE, accountId }).strict(),
])
export type TestEgressProxyBody = z.infer<typeof testEgressProxyBody>

/** The proxy a request names, resolved: a custom URL, or a vendor's own. */
export type ResolvedProxy =
  | { readonly url: string; readonly address: string; readonly from: null }
  | { readonly url: string; readonly address: string; readonly from: VendorProxy }

export async function resolveProxy(
  vendors: readonly ProxyVendor[],
  body: { readonly url: string } | { readonly vendor: string; readonly id: string },
): Promise<AdminResult<ResolvedProxy>> {
  if ("url" in body) {
    const url = new URL(body.url)
    if (!/^\/?$/.test(url.pathname) || url.search !== "" || url.hash !== "") {
      return invalid(
        "an egress proxy is http(s)://[user:password@]host:port",
        "egress_proxy_invalid",
      )
    }
    const port = url.port || (url.protocol === "https:" ? "443" : "80")
    return ok({ url: body.url, address: `${url.hostname}:${port}`, from: null })
  }
  if (!vendors.some((vendor) => vendor.id === body.vendor)) {
    return invalid(`no proxy vendor is named "${body.vendor}"`, "unknown_proxy_vendor")
  }
  const listing = await listOnce(vendors)(body.vendor)
  if (!listing.ok) return vendorFailure(body.vendor, listing)
  const chosen = listing.proxies.find((proxy) => proxy.id === body.id)
  if (chosen !== undefined) return ok({ url: chosen.url, address: chosen.address, from: chosen })
  return invalid(`${body.vendor} lists no proxy "${body.id}"`, "unknown_proxy")
}

/**
 * Whether this account may leave through a proxy at all. One that signs in cannot: its login and
 * refresh calls leave by another path, and half an account behind a proxy is one seen from two
 * addresses. One whose endpoint is plain `http` and holds a credential cannot either, because there
 * is no tunnel: the proxy would be handed the request, key included.
 */
export function proxyAllowed(account: AccountRow): AdminResult<null> {
  const provider = describeProvider(account.provider)
  if (provider.transport !== "http" || provider.connectFlow !== null) {
    return invalid(
      `provider "${provider.id}" signs in and refreshes outside the proxied path, so an egress proxy would cover only part of its traffic`,
      "egress_proxy_unsupported",
    )
  }
  return checkProxiedPlaintext({ ...account, hasCredential: account.authMaterial !== null })
}

/** What gets stored. A custom proxy has no vendor to take a replacement from. */
export function toStored(
  cipher: Pick<CredentialCipher, "encrypt">,
  proxy: ResolvedProxy,
  mode: ReplaceMode | undefined,
): AdminResult<StoredEgressProxy> {
  const base = { address: proxy.address, sealed: cipher.encrypt(proxy.url) }
  if (proxy.from === null) return mode === "on-failure" ? needsVendor() : ok(base)
  const { vendor, id: vendorId, country } = proxy.from
  return ok({ ...base, vendor, vendorId, country, replace: mode ?? "manual" })
}

export function needsVendor(): AdminResult<never> {
  return invalid(
    "only a proxy chosen from a vendor's list can be replaced on failure: a custom URL has no list to take another from",
    "replace_needs_vendor",
  )
}

/** `host:port` of the account's upstream, for a CONNECT probe. */
export function upstreamTarget(
  account: Pick<AccountRow, "id" | "provider" | "baseUrl" | "dialect">,
): ProbeTarget {
  const base = upstreamBase(account)
  if (base === null) return NEUTRAL_TARGET
  return `${base.hostname}:${base.port || (base.protocol === "http:" ? "80" : "443")}`
}
