import {
  coerceMessage,
  coerceStream,
  forcedToolFromRequest,
} from "../translate/shared/forced-tool-coercion"
import type { ServableCandidate } from "./plan"
import { DEFAULT_BUFFERED_BODY_MAX_BYTES, join, readRelayBody } from "./relay-body-read"

/**
 * The response half of `translate/shared/forced-tool-coercion.ts`: a forced tool a vendor answered
 * in text, buffered and moved into its `tool_use` block before the relay sees it.
 *
 * Applies only to an Account whose driver declares `thinkingOnByDefault` AND a request whose final
 * upstream body forces a tool, so an ordinary turn is relayed exactly as before. A forced stream is
 * held only until its first content block says whether the vendor obeyed (`coercedStream`); one
 * that answered in text is buffered whole and coerced. Anything that is not coerced is re-emitted
 * as the very bytes received.
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

/** The coercion target, only for a vendor that thinks by default and ignores a forced tool. */
export function forcedToolOn(
  servable: ServableCandidate,
  upstreamBody: Uint8Array | null,
): { forcedTool: string } | Record<string, never> {
  if (servable.kind !== "http" || servable.dialect !== "anthropic") return {}
  if (!servable.driver.thinkingOnByDefault?.(servable.account.driver)) return {}
  const forcedTool = forcedToolOfBody(upstreamBody)
  return forcedTool === undefined ? {} : { forcedTool }
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
  maxBytes: number = DEFAULT_BUFFERED_BODY_MAX_BYTES,
): Response {
  if (upstream.body === null) return upstream
  const streamed = upstream.headers.get("content-type")?.includes("text/event-stream") === true
  const headers = new Headers(upstream.headers)
  // The body may be rewritten, so the upstream's framing of the old one no longer describes it.
  headers.delete("content-length")
  headers.delete("content-encoding")

  const cancelled = new AbortController()
  const reading =
    signal === undefined ? cancelled.signal : AbortSignal.any([signal, cancelled.signal])
  const source = upstream.body
  const body = streamed
    ? coercedStream(source, tool, newId, maxBytes, () => onCoerced(true), reading)
    : new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const raw = await readRelayBody(source, reading, maxBytes)
            const coerced = coerceBody(raw, tool, newId)
            if (coerced !== null) onCoerced(false)
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

/**
 * A forced-tool stream, decided at its first content block (ruling on plan 101, 02.4): a `tool_use`
 * block means the vendor obeyed, so the held prefix is replayed and the rest relayed as it arrives;
 * a `text` or `thinking` block is read to the end and coerced as before. A stream past `maxBytes`
 * is relayed as it came rather than held without bound.
 */
function coercedStream(
  source: ReadableStream<Uint8Array>,
  tool: string,
  newId: () => string,
  maxBytes: number,
  onCoerced: () => void,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const held: Uint8Array[] = []
  const decoder = new TextDecoder()
  let text = ""
  let total = 0
  let mode: "deciding" | "coercing" | "relaying" = "deciding"
  const onAbort = () => void reader.cancel(signal.reason).catch(() => {})
  signal.addEventListener("abort", onAbort, { once: true })
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          for (;;) {
            if (mode === "relaying") {
              const next = held.shift()
              if (next !== undefined) {
                controller.enqueue(next)
                return
              }
              const read = await reader.read()
              if (read.done) controller.close()
              else controller.enqueue(read.value)
              return
            }
            const read = await reader.read()
            signal.throwIfAborted()
            if (read.done) {
              const raw = join(held, total)
              const coerced = coerceStream(raw, tool, newId)
              if (coerced !== null) onCoerced()
              controller.enqueue(coerced ?? raw)
              controller.close()
              return
            }
            held.push(read.value)
            total += read.value.length
            if (total > maxBytes) {
              mode = "relaying"
              continue
            }
            if (mode === "deciding") {
              text += decoder.decode(read.value, { stream: true })
              const first = firstContentBlock(text)
              if (first === "tool_use") mode = "relaying"
              else if (first !== undefined) mode = "coercing"
            }
          }
        } catch (error) {
          signal.removeEventListener("abort", onAbort)
          controller.error(error)
        }
      },
      cancel(reason) {
        signal.removeEventListener("abort", onAbort)
        return reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}

/** The type of the stream's first `content_block_start`, once a complete one has arrived. */
export function firstContentBlock(text: string): string | undefined {
  const marker = text.indexOf('"content_block_start"')
  if (marker < 0) return undefined
  const lineStart = text.lastIndexOf("data:", marker)
  const lineEnd = text.indexOf("\n", marker)
  if (lineStart < 0 || lineEnd < 0) return undefined
  try {
    const frame: unknown = JSON.parse(text.slice(lineStart + 5, lineEnd).trim())
    const block =
      typeof frame === "object" && frame !== null && "content_block" in frame
        ? (frame as { readonly content_block: unknown }).content_block
        : undefined
    const type =
      typeof block === "object" && block !== null && "type" in block
        ? (block as { readonly type: unknown }).type
        : undefined
    return typeof type === "string" ? type : "unknown"
  } catch {
    return "unknown"
  }
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
