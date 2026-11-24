export interface Endpoint {
  readonly baseUrl: string | null
  /** Empty or null: the provider's default. */
  readonly dialect: string | null
}

/**
 * Whether an edit would send an account's stored credential to another host, which the API refuses
 * unless the same edit carries a credential (`credential_required_for_new_endpoint`).
 *
 * `unknown` is to, from or between the provider's own endpoints, whose addresses only the router
 * holds: with no base URL, the dialect is what picks one. Text that is not an address yet is
 * `same`: the URL field says so itself.
 */
export function endpointMove(stored: Endpoint, edited: Endpoint): "same" | "moved" | "unknown" {
  const [before, after] = [stored.baseUrl ?? "", (edited.baseUrl ?? "").trim()]
  if (before === "" && after === "") {
    return (stored.dialect ?? "") === (edited.dialect ?? "") ? "same" : "unknown"
  }
  if (before === after) return "same"
  if (before === "" || after === "") return "unknown"
  const [from, to] = [originOf(before), originOf(after)]
  return from === null || to === null || from === to ? "same" : "moved"
}

function originOf(url: string): string | null {
  return URL.canParse(url) ? new URL(url).origin : null
}
