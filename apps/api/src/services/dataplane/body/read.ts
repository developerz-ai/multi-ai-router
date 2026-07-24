import { createHash } from "node:crypto"
import { TranslationError } from "@multi-ai-router/core"
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
 * over a materialized buffer, and stops early once both fields are in hand.
 *
 * This is not the streaming rule. That rule is about the **response**: upstream bytes are relayed
 * to the client as they arrive and are never accumulated (`relay.ts`).
 */

export interface BodyReadOptions extends ScannerOptions {
  /** Hard ceiling. An unbounded read is a denial-of-service surface, not a generosity. */
  readonly maxBytes?: number
}

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024

export interface RequestBody {
  readonly bytes: Uint8Array
  readonly fields: ScanResult
}

const TOO_LARGE = "Request body exceeds the configured size limit"

/** @throws TranslationError when the body exceeds `maxBytes`. */
export async function readRequestBody(
  stream: ReadableStream<Uint8Array> | null,
  options: BodyReadOptions = {},
): Promise<RequestBody> {
  const scanner = createRoutingScanner(options)
  const limit = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES

  if (stream === null) {
    return { bytes: new Uint8Array(0), fields: scanner.result() }
  }

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = stream.getReader()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.length
      // Thrown before the buffer grows past the limit, not after it has already been paid for.
      if (total > limit) throw new TranslationError(TOO_LARGE)
      chunks.push(value)
      if (!scanner.done) scanner.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  return { bytes: concat(chunks, total), fields: scanner.result() }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0]
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return bytes
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
 * Stable across the turns of one conversation, because a conversation grows by appending and its
 * first message does not change. Distinct between two conversations, because their first messages
 * differ. The working-directory half of the spec's fingerprint is not available over HTTP — no
 * client sends it in the body — so the header remains the authoritative source when there is one.
 */
export function fingerprintSessionKey(apiKeyId: string, conversationPrefix: Uint8Array): string {
  const hash = createHash("sha256")
  hash.update(apiKeyId, "utf8")
  hash.update(conversationPrefix)
  return `fp_${hash.digest("base64url").slice(0, 32)}`
}
