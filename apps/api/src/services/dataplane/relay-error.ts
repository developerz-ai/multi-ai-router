import type { Dialect } from "@multi-ai-router/core"
import { translateUpstreamError } from "../translate"
import type { UpstreamError } from "./attempt"

/**
 * The upstream's own error, as the client should see it.
 *
 * On the passthrough path the body is relayed unchanged: it is already in the ingress dialect's
 * shape, and re-rendering it would drop fields the provider stated. On the translate path it is
 * re-rendered into `ingress` — a Claude Code client gets an Anthropic-shaped error even when the
 * account that failed was an OpenAI one — with the message redacted and bounded, and naming no
 * account (docs/idea/06-protocol-translation.md#error-shapes, docs/idea/07-security.md).
 *
 * Only ever called with an error the upstream actually produced. A failure the router classified
 * itself is thrown as a `RouterError` so it renders in the ingress dialect through the usual path.
 */
export function relayUpstreamError(upstream: UpstreamError, ingress: Dialect | null): Response {
  const headers = new Headers()
  const retryAfter = upstream.headers.get("retry-after")
  if (retryAfter !== null) headers.set("retry-after", retryAfter)

  if (ingress === null) {
    if (upstream.contentType !== null) headers.set("content-type", upstream.contentType)
    return new Response(upstream.bodyText, { status: upstream.status, headers })
  }

  headers.set("content-type", "application/json")
  const body = translateUpstreamError(upstream.bodyText, upstream.status, ingress)
  return new Response(JSON.stringify(body), { status: upstream.status, headers })
}
