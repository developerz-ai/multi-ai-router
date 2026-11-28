import { z } from "zod"
import { readJsonCapped } from "../../models/capped-json"
import type { ProxyVendor, VendorProxy } from "./vendor"

/**
 * Decodo residential backconnect. Provenance: tesote/bank-integrations `exits/decodo.ts`
 * (`api.decodo.com/v2`, gateway `gate.decodo.com:7000`), 2026-11-27. Blast radius: a change here
 * empties the console's proxy picker and stops dead-proxy repair for Decodo; an account already
 * given a proxy keeps its own sealed copy.
 *
 * The API lists sub-user *usernames* only and never their passwords, so the gateway credential is a
 * second, explicit secret (`username` + `password`). Targeting is by username prefix
 * (`user-<u>-country-{cc}-session-{n16}-sessionduration-60`); a session is sixteen alphanumerics.
 */
const DECODO_API = "https://api.decodo.com/v2"
const DECODO_GATEWAY = "gate.decodo.com:7000"
const RESIDENTIAL = "residential_proxies"

/** Countries offered as rotation candidates (same reasoning as the ITRoyal vendor). */
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

const subUsers = z.array(
  z.object({
    username: z.string().min(1),
    status: z.string().nullish(),
    service_type: z.string().nullish(),
  }),
)

export interface DecodoDeps {
  /** API key, for the best-effort active-sub-user check. Unset: the vendor is off. */
  readonly apiKey: string | null
  /** Gateway username (a residential sub-user). */
  readonly username: string | null
  /** Gateway password. */
  readonly password: string | null
  readonly timeoutMs: number
  readonly maxBytes: number
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}

function randomToken(chars: string, length: number): string {
  let out = ""
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

/** `user-sp1-country-ve` → `sp1`: Decodo usernames hold no `-` after the prefix. */
const baseUsername = (username: string): string =>
  username.replace(/^user-/, "").split("-")[0] ?? ""

export function createDecodoVendor(deps: DecodoDeps): ProxyVendor {
  const call = deps.fetch ?? ((url, init) => fetch(url, init))

  return {
    id: "decodo",
    configured: () => deps.apiKey !== null && deps.username !== null && deps.password !== null,
    list: async (outer) => {
      if (deps.apiKey === null || deps.username === null || deps.password === null)
        return { ok: false, code: "off" as const }
      const { apiKey, username, password } = deps
      const deadline = AbortSignal.timeout(deps.timeoutMs)
      const signal = outer === undefined ? deadline : AbortSignal.any([deadline, outer])

      // Best-effort: only surface the credential while the sub-user is active. A listing failure
      // never fails the whole vendor — the probe validates the URL either way.
      let active: Set<string> | undefined
      try {
        const response = await call(`${DECODO_API}/sub-users?service_type=${RESIDENTIAL}`, {
          headers: { authorization: apiKey },
          redirect: "error",
          signal,
        })
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
        if (body.ok) {
          const parsed = subUsers.safeParse(body.value)
          if (parsed.success)
            active = new Set(
              parsed.data
                .filter((one) => one.status === "active")
                .map((one) => baseUsername(one.username)),
            )
        }
      } catch {
        active = undefined
      }
      const activeUser = baseUsername(username)
      const isActive = active === undefined || active.has(activeUser)
      if (!isActive) return { ok: true, proxies: [], complete: true }

      const encUser = encodeURIComponent(activeUser)
      const encPass = encodeURIComponent(password)
      const proxies: VendorProxy[] = COUNTRIES.map((country) => {
        const session = randomToken("0123456789abcdefghijklmnopqrstuvwxyz", 16)
        const url = `http://user-${encUser}-country-${country}-session-${session}-sessionduration-60:${encPass}@${DECODO_GATEWAY}`
        return {
          vendor: "decodo",
          id: country,
          address: `${DECODO_GATEWAY}:${country}`,
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
