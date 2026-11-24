import { type AdminResult, conflict, unavailable } from "../../admin/result"

/**
 * A company an operator rents proxies from. A second vendor is one file implementing this and one
 * line in `vendorsFromEnv`; nothing else names one.
 */
export interface ProxyVendor {
  readonly id: string
  /** Whether a key is set. Unset: nothing can be listed, and custom URLs still work. */
  configured(): boolean
  list(signal?: AbortSignal): Promise<VendorListing>
}

export interface VendorProxy {
  readonly vendor: string
  /** The vendor's own id, stable while its address or password changes. */
  readonly id: string
  readonly address: string
  readonly country: string | null
  readonly city: string | null
  /** The vendor's own verdict. */
  readonly valid: boolean
  readonly lastVerifiedAt: string | null
  /** The whole proxy URL, password included. Never leaves the services in this directory. */
  readonly url: string
}

export type VendorFailure =
  | "off"
  | "unauthorized"
  | "unreachable"
  | "timeout"
  | "too_large"
  | "unreadable"
  | "http_error"

export type VendorListing =
  | {
      readonly ok: true
      readonly proxies: readonly VendorProxy[]
      /** False when the page cap was reached: absence from the list then proves nothing. */
      readonly complete: boolean
    }
  | { readonly ok: false; readonly code: VendorFailure; readonly status?: number }

/** Fixed sentences: nothing a vendor answered, and no URL or key, can reach a response or a log. */
const SENTENCES: Readonly<Record<VendorFailure, string>> = {
  off: "has no API key set, so its proxies cannot be listed",
  unauthorized: "refused this router's API key",
  unreachable: "could not be reached",
  timeout: "did not answer in time",
  too_large: "answered with a list larger than this router reads",
  unreadable: "answered with something that is not the proxy list this router reads",
  http_error: "answered with an error",
}

export function vendorSentence(vendor: string, failure: { code: VendorFailure }): string {
  return `${vendor} ${SENTENCES[failure.code]}`
}

/** A failed listing as an admin failure: only the ones a clock can fix are worth resending. */
export function vendorFailure(
  vendor: string,
  failure: { readonly code: VendorFailure },
): AdminResult<never> {
  const message = vendorSentence(vendor, failure)
  if (failure.code === "off") return conflict(message, `${vendor}_off`)
  if (failure.code === "unauthorized") return conflict(message, `${vendor}_unauthorized`)
  return unavailable(message, `${vendor}_unavailable`)
}

/** One listing per vendor per caller: a sweep reads each inventory once, whoever asks first. */
export function listOnce(
  vendors: readonly ProxyVendor[],
  signal?: AbortSignal,
): (vendor: string) => Promise<VendorListing> {
  const asked = new Map<string, Promise<VendorListing>>()
  return (id) => {
    const held = asked.get(id)
    if (held !== undefined) return held
    const vendor = vendors.find((candidate) => candidate.id === id)
    const listing: Promise<VendorListing> =
      vendor === undefined || !vendor.configured()
        ? Promise.resolve({ ok: false, code: "off" })
        : vendor.list(signal)
    asked.set(id, listing)
    return listing
  }
}
