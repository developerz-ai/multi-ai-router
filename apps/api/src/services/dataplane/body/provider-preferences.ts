import { Buffer } from "node:buffer"
import type { ProviderPreferences } from "@multi-ai-router/core"
import { memberValue, topLevelMembers, withMember } from "./members"

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
 * no client of this router sends one — has the object spliced in after the opening brace. A body whose
 * top level really holds the key has that one value replaced. Every other byte is the client's either
 * way, and the body is never parsed (`members.ts`). Pure: no clock, no I/O, no logger.
 * A body that is not a JSON object comes back as the same bytes.
 */

const MARKER = new TextEncoder().encode('"provider"')

export function withProviderPreferences(
  bytes: Uint8Array,
  preferences: ProviderPreferences,
): Uint8Array {
  // The word is usually nowhere in the body, and its members then need not be stepped over.
  const top = topLevelMembers(bytes, contains(bytes, MARKER) ? ["provider"] : [])
  if (top === null) return bytes
  if (!top.values.has("provider")) return withMember(bytes, top, "provider", preferences)
  const stated = memberValue(bytes, top.values.get("provider"))
  return isRecord(stated)
    ? withMember(bytes, top, "provider", { ...preferences, ...stated })
    : bytes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).includes(needle)
}
