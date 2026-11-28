import { atLeastOne, nonEmpty } from "./fields"

/** Dead-proxy checks and repair, and the bounds on what a proxy vendor may answer. */
export const EGRESS_PROXY_ENV_FIELDS = {
  WEBSHARE_API_KEY: nonEmpty.optional(),
  WEBSHARE_TIMEOUT_MS: atLeastOne.optional(),
  // Backconnect vendors (IPRoyal / Decodo). A null token/apiKey turns that vendor off; the
  // timeout covers the whole listing. Decodo lists sub-user *usernames* only, so its gateway
  // credential (username + password) is a second, separate secret: the API never returns a password.
  IPROYAL_API_TOKEN: nonEmpty.optional(),
  IPROYAL_TIMEOUT_MS: atLeastOne.optional(),
  DECODO_API_KEY: nonEmpty.optional(),
  DECODO_GW_USERNAME: nonEmpty.optional(),
  DECODO_GW_PASSWORD: nonEmpty.optional(),
  DECODO_TIMEOUT_MS: atLeastOne.optional(),
  EGRESS_PROXY_CHECK_INTERVAL_MINUTES: atLeastOne.optional(),
  EGRESS_PROXY_CHECK_TIMEOUT_MS: atLeastOne.optional(),
  EGRESS_PROXY_CHECK_BATCH_SIZE: atLeastOne.optional(),
  EGRESS_PROXY_FAILURE_THRESHOLD: atLeastOne.optional(),
  EGRESS_PROXY_SWAP_COOLDOWN_MINUTES: atLeastOne.optional(),
  EGRESS_PROXY_VENDOR_MAX_PAGES: atLeastOne
    .refine((value) => value <= 100, "must be at most 100")
    .optional(),
  EGRESS_PROXY_VENDOR_MAX_BYTES: atLeastOne
    .refine((value) => value <= 16_777_216, "must be at most 16777216")
    .optional(),
}

interface RawEgressProxyEnv {
  readonly WEBSHARE_API_KEY?: string | undefined
  readonly WEBSHARE_TIMEOUT_MS?: number | undefined
  readonly IPROYAL_API_TOKEN?: string | undefined
  readonly IPROYAL_TIMEOUT_MS?: number | undefined
  readonly DECODO_API_KEY?: string | undefined
  readonly DECODO_GW_USERNAME?: string | undefined
  readonly DECODO_GW_PASSWORD?: string | undefined
  readonly DECODO_TIMEOUT_MS?: number | undefined
  readonly EGRESS_PROXY_CHECK_INTERVAL_MINUTES?: number | undefined
  readonly EGRESS_PROXY_CHECK_TIMEOUT_MS?: number | undefined
  readonly EGRESS_PROXY_CHECK_BATCH_SIZE?: number | undefined
  readonly EGRESS_PROXY_FAILURE_THRESHOLD?: number | undefined
  readonly EGRESS_PROXY_SWAP_COOLDOWN_MINUTES?: number | undefined
  readonly EGRESS_PROXY_VENDOR_MAX_PAGES?: number | undefined
  readonly EGRESS_PROXY_VENDOR_MAX_BYTES?: number | undefined
}

/** Webshare's listing. A null key turns it off; the deadline covers the whole listing. */
export interface WebshareEnv {
  readonly apiKey: string | null
  readonly timeoutMs: number
}

/**
 * IPRoyal's listing. The sub-user API returns each sub-user's own password, so the gateway URL is
 * buildable here (see `services/accounts/egress/iproyal.ts`). A null token turns it off.
 */
export interface IproyalEnv {
  readonly token: string | null
  readonly timeoutMs: number
}

/**
 * Decodo's listing. The API returns sub-user *usernames* only, so the gateway URL needs a second,
 * explicit credential (`username` + `password`) — the sub-user the operator rents traffic on. All
 * three must be set for the vendor to be on.
 */
export interface DecodoEnv {
  readonly apiKey: string | null
  readonly username: string | null
  readonly password: string | null
  readonly timeoutMs: number
}

export interface EgressProxyEnv {
  /** `egress_proxy_check` cadence. */
  readonly checkIntervalMinutes: number
  /** One probe's deadline. */
  readonly checkTimeoutMs: number
  /** Assigned proxies checked per tick, longest-unchecked first. */
  readonly checkBatchSize: number
  /** Consecutive proxy-level failures before an `on-failure` account may be moved. */
  readonly failureThreshold: number
  /** The least time between two swaps of one account. */
  readonly swapCooldownMinutes: number
  /** Pages of a vendor's list read before the listing is called incomplete. */
  readonly vendorMaxPages: number
  /** Largest vendor page accepted. */
  readonly vendorMaxBytes: number
}

export function readEgressProxyEnv(raw: RawEgressProxyEnv): {
  readonly webshare: WebshareEnv
  readonly iproyal: IproyalEnv
  readonly decodo: DecodoEnv
  readonly egressProxy: EgressProxyEnv
} {
  return {
    webshare: {
      apiKey: raw.WEBSHARE_API_KEY ?? null,
      timeoutMs: raw.WEBSHARE_TIMEOUT_MS ?? 10_000,
    },
    iproyal: {
      token: raw.IPROYAL_API_TOKEN ?? null,
      timeoutMs: raw.IPROYAL_TIMEOUT_MS ?? 10_000,
    },
    decodo: {
      apiKey: raw.DECODO_API_KEY ?? null,
      username: raw.DECODO_GW_USERNAME ?? null,
      password: raw.DECODO_GW_PASSWORD ?? null,
      timeoutMs: raw.DECODO_TIMEOUT_MS ?? 10_000,
    },
    egressProxy: {
      checkIntervalMinutes: raw.EGRESS_PROXY_CHECK_INTERVAL_MINUTES ?? 5,
      checkTimeoutMs: raw.EGRESS_PROXY_CHECK_TIMEOUT_MS ?? 5_000,
      checkBatchSize: raw.EGRESS_PROXY_CHECK_BATCH_SIZE ?? 50,
      failureThreshold: raw.EGRESS_PROXY_FAILURE_THRESHOLD ?? 3,
      swapCooldownMinutes: raw.EGRESS_PROXY_SWAP_COOLDOWN_MINUTES ?? 360,
      vendorMaxPages: raw.EGRESS_PROXY_VENDOR_MAX_PAGES ?? 10,
      vendorMaxBytes: raw.EGRESS_PROXY_VENDOR_MAX_BYTES ?? 1_048_576,
    },
  }
}
