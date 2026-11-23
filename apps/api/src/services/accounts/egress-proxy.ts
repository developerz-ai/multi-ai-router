import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import { z } from "zod"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminResult, conflict, invalid, notFound, ok } from "../admin/result"
import type { CredentialCipher } from "../crypto/cipher"
import { describeProvider } from "./providers"
import { type AccountView, toAccountView } from "./view"
import { listWebshareProxies, type WebshareConfig, type WebshareProxy } from "./webshare"

/**
 * One static egress proxy per account, or none. Nothing here picks, rotates or retries through
 * another address: the operator names the proxy and the account keeps it until they change it.
 */

const PROXY_PROTOCOLS: readonly string[] = ["http:", "https:"]
const PROXY_URL = z.url({ protocol: /^https?$/ }).max(2048)

export const setEgressProxyBody = z.union([
  z.object({ url: PROXY_URL }).strict(),
  // Named by vendor so a second one is a value here and a branch in `proxyUrl`, not a new body.
  z.object({ vendor: z.literal("webshare"), id: z.string().trim().min(1).max(64) }).strict(),
])
export type SetEgressProxyBody = z.infer<typeof setEgressProxyBody>

export interface EgressProxyList {
  /** Whether `WEBSHARE_API_KEY` is set. False: the list is empty because nothing can be listed. */
  readonly configured: boolean
  readonly proxies: readonly Omit<WebshareProxy, "url">[]
}

export interface EgressProxyService {
  list(): Promise<AdminResult<EgressProxyList>>
  set(accountId: string, body: SetEgressProxyBody): Promise<AdminResult<AccountView>>
  clear(accountId: string): Promise<AdminResult<AccountView>>
}

export interface EgressProxyServiceDeps {
  readonly accounts: Pick<AccountRepository, "findById" | "updateOperatorAccount">
  readonly cipher: Pick<CredentialCipher, "encrypt">
  readonly audit: AuditRecorder
  readonly now: () => Date
  readonly webshare: WebshareConfig
  /** Refreshes the routing catalog, so the next request already leaves through the new address. */
  readonly coherence: { refreshCatalog(): Promise<void> }
  readonly fetch?: typeof globalThis.fetch
}

export function createEgressProxyService(deps: EgressProxyServiceDeps): EgressProxyService {
  const webshare = () => listWebshareProxies(deps.webshare, deps.fetch ?? globalThis.fetch)

  const write = async (
    id: string,
    egressProxy: AccountRow["egressProxy"],
  ): Promise<AdminResult<AccountView>> => {
    const row = await deps.accounts.updateOperatorAccount({
      id,
      patch: { egressProxy },
      now: deps.now(),
    })
    if (row === undefined) return notFound(`no account with id "${id}"`)
    await deps.coherence.refreshCatalog()
    await deps.audit.record({
      kind: AUDIT_KINDS.accountUpdated,
      subjectType: AUDIT_SUBJECTS.account,
      subjectId: row.id,
      detail: {
        label: row.label,
        fields: ["egressProxy"],
        egressProxy: egressProxy?.address ?? null,
      },
    })
    return ok(toAccountView(row))
  }

  return {
    list: async () => {
      if (deps.webshare.apiKey === null) return ok({ configured: false, proxies: [] })
      const listed = await webshare()
      if (!listed.ok) return listed
      return ok({ configured: true, proxies: listed.value.map(({ url: _url, ...shown }) => shown) })
    },

    set: async (id, body) => {
      const account = await deps.accounts.findById(id)
      if (account === undefined) return notFound(`no account with id "${id}"`)
      const provider = describeProvider(account.provider)
      // A login has calls of its own (refresh, the `claude` CLI) that this does not carry. Half an
      // account behind a proxy is one seen from two addresses, so it is refused instead.
      if (provider.transport !== "http" || provider.connectFlow !== null) {
        return invalid(
          `provider "${provider.id}" signs in and refreshes outside the proxied path, so an egress proxy would cover only part of its traffic`,
          "egress_proxy_unsupported",
        )
      }
      const url = await proxyUrl(body)
      if (!url.ok) return url
      const parsed = new URL(url.value)
      if (
        !PROXY_PROTOCOLS.includes(parsed.protocol) ||
        !/^\/?$/.test(parsed.pathname) ||
        parsed.search
      ) {
        return invalid(
          "an egress proxy is http(s)://[user:password@]host:port",
          "egress_proxy_invalid",
        )
      }
      const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80")
      return write(id, {
        address: `${parsed.hostname}:${port}`,
        sealed: deps.cipher.encrypt(url.value),
      })
    },

    clear: async (id) => {
      const account = await deps.accounts.findById(id)
      return account === undefined ? notFound(`no account with id "${id}"`) : write(id, null)
    },
  }

  async function proxyUrl(body: SetEgressProxyBody): Promise<AdminResult<string>> {
    if ("url" in body) return ok(body.url)
    if (deps.webshare.apiKey === null) {
      return conflict(
        "WEBSHARE_API_KEY is not set, so no Webshare proxy can be chosen",
        "webshare_off",
      )
    }
    const listed = await webshare()
    if (!listed.ok) return listed
    const chosen = listed.value.find((proxy) => proxy.id === body.id)
    return chosen === undefined
      ? notFound(`Webshare lists no proxy "${body.id}" on this account`)
      : ok(chosen.url)
  }
}
