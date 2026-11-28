import { z } from "zod"
import { readJsonCapped } from "../../models/capped-json"
import type { ProxyVendor, VendorProxy } from "./vendor"

/**
 * ITRoyal residential backconnect. Provenance: a private egress client already in production
 * (`resi-api.iproyal.com/v1/residential-subusers`, gateway `geo.iproyal.com:12321`), cross-checked
 * against a live sub-user list 2026-11-27. Blast radius: a change here empties the console's proxy
 * picker and stops dead-proxy repair for ITRoyal; an account already given a proxy keeps its own
 * sealed copy.
 *
 * The sub-user API answers WITH its password, so the gateway URL is buildable here. ITRoyal targets
 * by password suffix (`<pass>_country-{cc}_session-{n8}_lifetime-60m`); a session is exactly eight
 * alphanumerics, so each candidate is a different region of a different IP.
 */
const IPROYAL_API = "https://resi-api.iproyal.com/v1"
const IPROYAL_GATEWAY = "geo.iproyal.com:12321"

/** Countries offered as rotation candidates. Different countries are different IP pools, so an
 * on-failure swap rotates through them. Expandable; a country the plan lacks still routes anywhere. */
const COUNTRIES = [
  "us",
  "gb",
  "de",
  "fr",
  "ca",
  "es",
  "br",
  "in",
  "au",
  "jp",
  "nl",
  "se",
  "it",
  "pl",
  "kr",
] as const

const subUsers = z.object({
  data: z.array(
    z.object({
      username: z.string().min(1),
      password: z.string().min(1),
      traffic_available: z.number().nullish(),
    }),
  ),
})

export interface IproyalDeps {
  /** Unset: the vendor is off. */
  readonly token: string | null
  /** Covers the whole listing. */
  readonly timeoutMs: number
  readonly maxBytes: number
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}

function randomToken(chars: string, length: number): string {
  let out = ""
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

export function createIproyalVendor(deps: IproyalDeps): ProxyVendor {
  const call = deps.fetch ?? ((url, init) => fetch(url, init))

  return {
    id: "iproyal",
    configured: () => deps.token !== null,
    list: async (outer) => {
      if (deps.token === null) return { ok: false, code: "off" as const }
      const deadline = AbortSignal.timeout(deps.timeoutMs)
      const signal = outer === undefined ? deadline : AbortSignal.any([deadline, outer])
      let response: Response
      try {
        response = await call(`${IPROYAL_API}/residential-subusers?page=1&per_page=100`, {
          headers: { authorization: `Bearer ${deps.token}` },
          redirect: "error",
          signal,
        })
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
      const parsed = subUsers.safeParse(body.value)
      if (!parsed.success) return { ok: false, code: "unreadable" }
      // First sub-user with a usable credential; sorted for a stable pick across listings.
      const sub = parsed.data.data
        .filter((one) => one.username !== "" && one.password !== "")
        .sort((a, b) => a.username.localeCompare(b.username))
      if (sub.length === 0) return { ok: true, proxies: [], complete: true }
      const [first] = sub
      if (!first) return { ok: true, proxies: [], complete: true }
      const encUser = encodeURIComponent(first.username)
      const encPass = encodeURIComponent(first.password)
      const proxies: VendorProxy[] = COUNTRIES.map((country) => {
        const session = randomToken("0123456789abcdefghijklmnopqrstuvwxyz", 8)
        const url = `http://${encUser}:${encPass}_country-${country}_session-${session}_lifetime-60m@${IPROYAL_GATEWAY}`
        return {
          vendor: "iproyal",
          id: country,
          address: `${IPROYAL_GATEWAY}:${country}`,
          country,
          city: null,
          valid: true,
          lastVerifiedAt: null,
          url,
        }
      })
      return { ok: true, proxies, complete: true }
    },
  }
}
