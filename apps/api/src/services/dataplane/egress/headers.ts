/** Only protocol negotiation crosses the client/provider trust boundary. */
const REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "anthropic-beta",
  "anthropic-version",
  "openai-beta",
  "x-request-id",
])

/** Account, organization, quota, cookies and upstream connection details remain private. */
const RESPONSE_HEADERS = new Set(["content-type", "retry-after", "cache-control"])

function allowedHeaders(source: Headers, allowed: ReadonlySet<string>): Headers {
  const headers = new Headers()
  // Connection can nominate additional hop-by-hop fields, even normally allowed ones.
  const connection = new Set(
    (source.get("connection") ?? "").split(",").map((name) => name.trim().toLowerCase()),
  )
  source.forEach((value, name) => {
    if (allowed.has(name) && !connection.has(name)) headers.set(name, value)
  })
  return headers
}

export function upstreamHeaders(client: Headers, driverHeaders: Headers): Headers {
  const headers = allowedHeaders(client, REQUEST_HEADERS)
  // Only the selected account's driver may supply credentials and account-routing headers.
  driverHeaders.forEach((value, name) => {
    headers.set(name, value)
  })
  return headers
}

export function clientHeaders(upstream: Headers): Headers {
  return allowedHeaders(upstream, RESPONSE_HEADERS)
}

/** Driver-only headers may identify a credential or tenant, even under an unknown name. */
export function privateHeaderValues(driverHeaders: Headers): string[] {
  const values: string[] = []
  driverHeaders.forEach((value, name) => {
    if (value.length > 0 && !REQUEST_HEADERS.has(name)) values.push(value)
  })
  return values
}
