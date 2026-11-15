import { Buffer } from "node:buffer"
import type { ProviderPreferences } from "@multi-ai-router/core"

/**
 * An account's `provider` routing preferences, written into the body that account is sent
 * (`ProviderSurface.providerPreferences`: OpenRouter). The operator's standing instruction for how
 * that upstream picks an endpoint — `sort: price`, `quantizations: [fp8, bf16]` — which a model
 * slug's `:floor` suffix can only half say. The model is never touched (non-negotiable 4).
 *
 * **The client wins, field by field.** The account's object supplies each field the client's own
 * `provider` leaves out; a field the client states is the client's, falsy values included. The
 * account's preferences are a default for a whole pool of callers; a caller that names, say,
 * `require_parameters` or its own `order` knows something about this one request the operator could
 * not, and a router that overwrote it would be second-guessing a request it was asked to relay —
 * the same reason a client's `prompt_cache_key` is left alone (`chain-body.ts`). An operator who
 * must *enforce* a quantization against every caller does so with a key it hands only to callers
 * that do not override it. One level deep: a client `sort` object replaces the account's `sort`
 * whole. A client `provider` that is not an object (`null`, a string) is the client's statement and
 * the upstream's to judge: the body goes as sent.
 *
 * **Cheap on the common path.** A body with no `"provider"` bytes at all — every request today, as
 * no client of this router sends one — is never parsed: the object is spliced in after the opening
 * brace and every other byte is the client's. Only a body that contains the word is parsed, and only
 * one whose top level really holds the key is re-serialized. Pure: no clock, no I/O, no logger.
 * A body that is not a JSON object comes back as the same bytes.
 */

const MARKER = new TextEncoder().encode('"provider"')
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d

export function withProviderPreferences(
  bytes: Uint8Array,
  preferences: ProviderPreferences,
): Uint8Array {
  const open = firstNonWhitespace(bytes, 0)
  if (open === -1 || bytes[open] !== OPEN_BRACE) return bytes
  if (!contains(bytes, MARKER)) return splice(bytes, open, preferences)

  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return bytes
  }
  if (!isRecord(body)) return bytes
  // The word was somewhere in the conversation, not a field of the request.
  if (!Object.hasOwn(body, "provider")) return splice(bytes, open, preferences)
  const stated = body.provider
  if (!isRecord(stated)) return bytes
  return new TextEncoder().encode(
    JSON.stringify({ ...body, provider: { ...preferences, ...stated } }),
  )
}

/** `{"provider":{…},` after the body's opening brace, and no comma when the object is empty. */
function splice(bytes: Uint8Array, open: number, preferences: ProviderPreferences): Uint8Array {
  const empty = bytes[firstNonWhitespace(bytes, open + 1)] === CLOSE_BRACE
  const field = new TextEncoder().encode(
    `"provider":${JSON.stringify(preferences)}${empty ? "" : ","}`,
  )
  const out = new Uint8Array(bytes.length + field.length)
  out.set(bytes.subarray(0, open + 1), 0)
  out.set(field, open + 1)
  out.set(bytes.subarray(open + 1), open + 1 + field.length)
  return out
}

/** JSON's four whitespace bytes; -1 when only whitespace remains. */
function firstNonWhitespace(bytes: Uint8Array, from: number): number {
  for (let i = from; i < bytes.length; i++) {
    const b = bytes[i]
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return i
  }
  return -1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).includes(needle)
}
