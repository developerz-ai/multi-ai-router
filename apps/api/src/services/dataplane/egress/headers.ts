/**
 * Header swapping — the whole of what a passthrough does to a request besides addressing it.
 *
 * Outbound: the router key is stripped, hop-by-hop headers are dropped, everything else the client
 * sent survives (a beta flag the router has never heard of included — that is the property
 * passthrough exists for), and the driver's own headers are applied **last** so a client can never
 * override the credential or the provider's mandated version header.
 *
 * Inbound: the upstream's headers reach the client minus the ones that describe a connection
 * rather than a response. `content-encoding` and `content-length` go because `fetch` already
 * decoded the body — relaying them would describe bytes that no longer exist.
 */

/** Hop-by-hop headers: properties of one connection, meaningless on the next one. */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]

/** Never forwarded upstream: the router's own credential space, and framing `fetch` recomputes. */
const STRIP_FROM_REQUEST = [
  ...HOP_BY_HOP,
  "authorization",
  "x-api-key",
  "cookie",
  "host",
  "content-length",
  "expect",
  // Let the HTTP client negotiate its own encoding: it is the one that has to decode the reply.
  "accept-encoding",
]

const STRIP_FROM_RESPONSE = [
  ...HOP_BY_HOP,
  "content-encoding",
  "content-length",
  // A cookie an upstream sets is scoped to the upstream's origin and means nothing on ours.
  "set-cookie",
]

export function upstreamHeaders(client: Headers, driverHeaders: Headers): Headers {
  const headers = new Headers()

  client.forEach((value, name) => {
    if (STRIP_FROM_REQUEST.includes(name.toLowerCase())) return
    headers.set(name, value)
  })

  // Last, and unconditionally: the credential and the provider's required headers are the
  // router's to set, and a client-supplied `anthropic-version` must not displace the driver's.
  driverHeaders.forEach((value, name) => {
    headers.set(name, value)
  })

  return headers
}

export function clientHeaders(upstream: Headers): Headers {
  const headers = new Headers()
  upstream.forEach((value, name) => {
    if (STRIP_FROM_RESPONSE.includes(name.toLowerCase())) return
    headers.set(name, value)
  })
  return headers
}
