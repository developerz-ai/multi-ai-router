import { z } from "zod"
import { readJsonCapped } from "../../models/capped-json"
import type { ProxyVendor, VendorListing, VendorProxy } from "./vendor"

/**
 * Provenance: https://apidocs.webshare.io/proxy-list/list, checked against a live account 2026-11-23.
 * Blast radius: a change here empties the console's proxy picker and stops dead-proxy repair for
 * Webshare; an account already given a proxy keeps its own sealed copy.
 */
const WEBSHARE_PROXIES_URL = "https://proxy.webshare.io/api/v2/proxy/list/"
const PAGE_SIZE = 100

const listing = z.object({
  // Read for whether it is there, never followed: the key would go wherever it points.
  next: z.string().nullish(),
  results: z.array(
    z.object({
      id: z.string().min(1),
      username: z.string(),
      password: z.string(),
      proxy_address: z.string().min(1),
      port: z.number().int().positive(),
      valid: z.boolean(),
      last_verification: z.string().nullish(),
      country_code: z.string().nullish(),
      city_name: z.string().nullish(),
    }),
  ),
})

export interface WebshareDeps {
  readonly apiKey: string | null
  /** Covers the whole listing, every page of it. */
  readonly timeoutMs: number
  readonly maxPages: number
  readonly maxBytes: number
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}

export function createWebshareVendor(deps: WebshareDeps): ProxyVendor {
  const call = deps.fetch ?? ((url, init) => fetch(url, init))

  const page = async (
    number: number,
    signal: AbortSignal,
  ): Promise<z.infer<typeof listing> | Extract<VendorListing, { ok: false }>> => {
    let response: Response
    try {
      response = await call(
        `${WEBSHARE_PROXIES_URL}?mode=direct&page=${number}&page_size=${PAGE_SIZE}`,
        { headers: { authorization: `Token ${deps.apiKey}` }, redirect: "error", signal },
      )
    } catch {
      return { ok: false, code: signal.aborted ? "timeout" : "unreachable" }
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      const { status } = response
      return {
        ok: false,
        code: status === 401 || status === 403 ? "unauthorized" : "http_error",
        status,
      }
    }
    const body = await readJsonCapped(response, deps.maxBytes)
    if (!body.ok) {
      if (signal.aborted) return { ok: false, code: "timeout" }
      return { ok: false, code: body.reason === "too-large" ? "too_large" : "unreadable" }
    }
    const parsed = listing.safeParse(body.value)
    return parsed.success ? parsed.data : { ok: false, code: "unreadable" }
  }

  return {
    id: "webshare",
    configured: () => deps.apiKey !== null,
    list: async (outer) => {
      if (deps.apiKey === null) return { ok: false, code: "off" }
      const deadline = AbortSignal.timeout(deps.timeoutMs)
      const signal = outer === undefined ? deadline : AbortSignal.any([deadline, outer])
      const proxies: VendorProxy[] = []
      for (let number = 1; number <= deps.maxPages; number++) {
        const read = await page(number, signal)
        if ("ok" in read) return read
        proxies.push(...read.results.map(toProxy))
        if (read.next == null) return { ok: true, proxies, complete: true }
      }
      return { ok: true, proxies, complete: false }
    },
  }
}

function toProxy(row: z.infer<typeof listing>["results"][number]): VendorProxy {
  const host = row.proxy_address.includes(":") ? `[${row.proxy_address}]` : row.proxy_address
  return {
    vendor: "webshare",
    id: row.id,
    address: `${host}:${row.port}`,
    country: row.country_code ?? null,
    city: row.city_name ?? null,
    valid: row.valid,
    lastVerifiedAt: row.last_verification ?? null,
    url: `http://${encodeURIComponent(row.username)}:${encodeURIComponent(row.password)}@${host}:${row.port}`,
  }
}
