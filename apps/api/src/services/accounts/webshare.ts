import { z } from "zod"
import { type AdminResult, conflict, ok } from "../admin/result"

/**
 * Provenance: https://apidocs.webshare.io/proxy-list/list, checked against a live account 2026-11-23.
 * Blast radius: a change here only empties the console's proxy picker; an account already given a
 * proxy keeps its own sealed copy.
 */
const WEBSHARE_PROXIES_URL =
  "https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100"

const listing = z.object({
  results: z.array(
    z.object({
      id: z.string().min(1),
      username: z.string(),
      password: z.string(),
      proxy_address: z.string().min(1),
      port: z.number().int().positive(),
      valid: z.boolean(),
      country_code: z.string().nullish(),
      city_name: z.string().nullish(),
    }),
  ),
})

export interface WebshareConfig {
  readonly apiKey: string | null
  readonly timeoutMs: number
}

export interface WebshareProxy {
  readonly vendor: "webshare"
  readonly id: string
  readonly address: string
  readonly location: string
  readonly valid: boolean
  /** Carries the proxy's password. Never leaves the API process. */
  readonly url: string
}

/** The account's own proxies. A failure says what happened and quotes nothing from the answer. */
export async function listWebshareProxies(
  config: WebshareConfig,
  fetch: typeof globalThis.fetch,
): Promise<AdminResult<readonly WebshareProxy[]>> {
  let body: unknown
  try {
    const response = await fetch(WEBSHARE_PROXIES_URL, {
      headers: { authorization: `Token ${config.apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    if (!response.ok) return unavailable(`Webshare answered ${response.status}`)
    body = await response.json()
  } catch {
    return unavailable("Webshare could not be reached")
  }
  const parsed = listing.safeParse(body)
  if (!parsed.success) return unavailable("Webshare's answer was not the proxy list this reads")
  return ok(
    parsed.data.results.map((proxy) => ({
      vendor: "webshare" as const,
      id: proxy.id,
      address: `${proxy.proxy_address}:${proxy.port}`,
      location: [proxy.city_name, proxy.country_code].filter(Boolean).join(", "),
      valid: proxy.valid,
      url: `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.proxy_address}:${proxy.port}`,
    })),
  )
}

const unavailable = (message: string) => conflict(message, "webshare_unavailable")
