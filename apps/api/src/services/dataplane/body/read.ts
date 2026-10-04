import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { RequestTooLargeError } from "@multi-ai-router/core"
import {
  type ByteSpan,
  createRoutingScanner,
  type ScannerOptions,
  type ScanResult,
} from "./scanner"

/**
 * Reading a request body once, extracting routing fields as it arrives, and forwarding the bytes
 * unchanged.
 *
 * The body is read into memory because routing cannot begin without the model name and the model
 * name lives inside it — but it is never parsed, never re-serialized, and the exact bytes the
 * client sent are what goes upstream. The scan happens **per chunk as it arrives**, not afterwards
 * over a materialized buffer. Routing-field capture is bounded; structural validation continues
 * through EOF so later duplicate fields or malformed JSON cannot bypass admission.
 *
 * This is not the streaming rule. That rule is about the **response**: upstream bytes are relayed
 * to the client as they arrive and are never accumulated (`relay.ts`).
 */

export interface BodyReadOptions extends ScannerOptions {
  /** Request/registry cancellation; its exact typed reason is preserved. */
  readonly signal?: AbortSignal
  /**
   * Hard ceiling, in bytes. An unbounded read is a denial-of-service surface, not a generosity.
   *
   * Operator-configured (`MAX_REQUEST_BODY_BYTES`), because the right value is a property of the
   * deployment and not of this file: a router fronting agents that paste whole repositories into a
   * prompt needs a different number from one serving chat, and a limit compiled into the binary is
   * one an operator cannot move.
   */
  readonly maxBytes?: number
  /** Injected monotonic clock; only time awaiting reads is reported. */
  readonly elapsed?: () => number
  readonly onReadWaitStart?: (started: number) => void
  readonly onReadWait?: (milliseconds: number) => void
}

/** Generous, because a long agent transcript with base64 images is a normal request. */
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024

/** What the reader needs of a request: the bytes, and what the client claimed it was sending. */
export type RequestBodySource = Pick<Request, "body" | "headers">

export interface RequestBody {
  readonly bytes: Uint8Array
  readonly fields: ScanResult
}

const TOO_LARGE = "Request body exceeds the configured size limit"

/** @throws RequestTooLargeError when the body exceeds `maxBytes`. */
export async function readRequestBody(
  request: RequestBodySource,
  options: BodyReadOptions = {},
): Promise<RequestBody> {
  options.signal?.throwIfAborted()
  const scanner = createRoutingScanner(options)
  const elapsed = options.elapsed ?? (() => performance.now())
  const limit = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES

  // The cheapest refusal there is: a client announcing four gigabytes is turned away before the
  // first chunk is read, rather than after the ceiling's worth of it has been streamed, buffered,
  // and thrown away. A body that lies about its length is still caught below.
  const declared = declaredBodyBytes(request.headers)
  if (declared !== null && declared > limit) throw new RequestTooLargeError(TOO_LARGE)

  const stream = request.body
  if (stream === null) {
    return { bytes: new Uint8Array(0), fields: scanner.result() }
  }

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = stream.getReader()

  try {
    for (;;) {
      const started = elapsed()
      options.onReadWaitStart?.(started)
      let reading: BodyChunk
      try {
        reading = await readAbortable(reader, options.signal)
      } finally {
        options.onReadWait?.(Math.max(0, elapsed() - started))
      }
      const { done, value } = reading
      if (done) break
      if (value === undefined) continue
      total += value.length
      // Thrown before the buffer grows past the limit, not after it has already been paid for.
      if (total > limit) throw new RequestTooLargeError(TOO_LARGE)
      chunks.push(value)
      if (!scanner.done) scanner.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  return { bytes: concat(chunks, total), fields: scanner.finish() }
}

type BodyChunk = { readonly done: boolean; readonly value?: Uint8Array }

/** One listener per pending read: completed chunks retain no abort reactions. */
async function readAbortable(
  reader: { read(): Promise<BodyChunk>; cancel(reason?: unknown): Promise<void> },
  signal: AbortSignal | undefined,
): Promise<BodyChunk> {
  if (signal === undefined) return reader.read()
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = () => {
    // Reject first: cancellation can resolve the pending read as EOF synchronously.
    aborted.reject(signal.reason)
    try {
      void reader.cancel(signal.reason).catch(() => {})
    } catch {
      // Best effort only; cancellation must not replace the cause or extend shutdown.
    }
  }
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    if (signal.aborted) {
      onAbort()
      return await aborted.promise
    }
    return await Promise.race([reader.read(), aborted.promise])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

/** RFC 9110's `Content-Length` is `1*DIGIT` and nothing else. */
const CONTENT_LENGTH_SHAPE = /^\d+$/

/**
 * The length the client declared, or null when it declared none the router can act on.
 *
 * Anything malformed — a signed value, a list of values, a float, whitespace — is *ignored* rather
 * than rejected: the streaming ceiling is the authority on how many bytes actually arrived, and a
 * proxy that refuses a request over a header it could simply not trust breaks callers for no gain.
 */
export function declaredBodyBytes(headers: Pick<Headers, "get">): number | null {
  const raw = headers.get("content-length")
  if (raw === null || !CONTENT_LENGTH_SHAPE.test(raw)) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0]
  return Buffer.concat(chunks, total)
}

/**
 * Rewrites the model name in place, by byte span.
 *
 * The one edit a passthrough body ever receives, and only when the selected Account's operator-
 * authored alias map renames the model (`sonnet` -> `glm-4.7`). Everything around the span is
 * copied verbatim — no parse, no re-serialization, no reordered keys, no dropped unknown fields.
 * The router never substitutes a model on its own; an alias is the operator saying otherwise.
 */
export function rewriteModel(bytes: Uint8Array, span: ByteSpan, upstreamModel: string): Uint8Array {
  const replacement = new TextEncoder().encode(jsonEscape(upstreamModel))
  const out = new Uint8Array(bytes.length - (span.end - span.start) + replacement.length)
  out.set(bytes.subarray(0, span.start), 0)
  out.set(replacement, span.start)
  out.set(bytes.subarray(span.end), span.start + replacement.length)
  return out
}

/** Alias values are operator-authored, so this covers the characters a model id could carry. */
function jsonEscape(value: string): string {
  const encoded = JSON.stringify(value)
  return encoded.slice(1, -1)
}

/**
 * The session key when the client did not supply one: a fingerprint of the conversation's opening
 * bytes, scoped to the presenting key so two keys never share a session.
 *
 * Stable when turns append without changing the captured raw opening bytes. The bounded prefix
 * can collide for identical openings, and JSON reformatting can change it. A remote working
 * directory is not inferred over HTTP; an explicit session header names conversation boundaries.
 */
export function fingerprintSessionKey(apiKeyId: string, conversationPrefix: Uint8Array): string {
  const hash = createHash("sha256")
  hash.update(apiKeyId, "utf8")
  hash.update(conversationPrefix)
  return `fp_${hash.digest("base64url").slice(0, 32)}`
}
