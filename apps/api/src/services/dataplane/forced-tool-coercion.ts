import {
  coerceMessage,
  coerceStream,
  forcedToolFromRequest,
} from "../translate/shared/forced-tool-coercion"
import { readRelayBody } from "./relay-body-read"

/**
 * The response half of `translate/shared/forced-tool-coercion.ts`: a forced tool a vendor answered
 * in text, buffered and moved into its `tool_use` block before the relay sees it.
 *
 * Applies only to an Account whose driver declares `thinkingOnByDefault` AND a request whose final
 * upstream body forces a tool, so an ordinary turn is relayed exactly as before. A forced request
 * is buffered whole — a stream included — because the answer cannot be classified until it has
 * ended; that costs the time-to-first-token of the forced calls of these vendors and nothing else.
 * Anything that is not coerced is re-emitted as the very bytes received.
 *
 * @param onCoerced fired once per coerced response with `streamed`; carries no content, so the
 * caller can count and log how often a vendor ignores a force.
 */

const MARKER = new TextEncoder().encode('"tool_choice"')

/** The tool the upstream body (already in the anthropic dialect) forces, or `undefined`. */
export function forcedToolOfBody(bytes: Uint8Array | null): string | undefined {
  if (bytes === null) return undefined
  if (!Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(MARKER)) {
    return undefined
  }
  try {
    return forcedToolFromRequest(JSON.parse(new TextDecoder().decode(bytes))) ?? undefined
  } catch {
    return undefined
  }
}

export function newToolUseId(): string {
  return `toolu_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`
}

export function coerceForcedToolResponse(
  upstream: Response,
  tool: string,
  onCoerced: (streamed: boolean) => void,
  signal?: AbortSignal,
  newId: () => string = newToolUseId,
): Response {
  if (upstream.body === null) return upstream
  const streamed = upstream.headers.get("content-type")?.includes("text/event-stream") === true
  const headers = new Headers(upstream.headers)
  // The body is rewritten, so the upstream's framing of the old one no longer describes it.
  headers.delete("content-length")
  headers.delete("content-encoding")

  const cancelled = new AbortController()
  const reading =
    signal === undefined ? cancelled.signal : AbortSignal.any([signal, cancelled.signal])
  const source = upstream.body
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const raw = await readRelayBody(source, reading)
        const coerced = streamed ? coerceStream(raw, tool, newId) : coerceBody(raw, tool, newId)
        if (coerced !== null) onCoerced(streamed)
        controller.enqueue(coerced ?? raw)
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      cancelled.abort(reason)
    },
  })
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers })
}

function coerceBody(raw: Uint8Array, tool: string, newId: () => string): Uint8Array | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return null
  }
  const message = coerceMessage(parsed, tool, newId)
  return message === null ? null : new TextEncoder().encode(JSON.stringify(message))
}
