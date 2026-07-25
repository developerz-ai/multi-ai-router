import type { Dialect } from "@multi-ai-router/core"
import { z } from "zod"
import { type ErrorBody, renderErrorBody } from "../../../errors/render"
import { redactValue } from "../../../logging/redact"

/**
 * An upstream's error body, re-rendered into the **ingress** dialect.
 *
 * A Claude Code client speaks Anthropic and gets an Anthropic-shaped error even when the account
 * that failed was an OpenAI one (`docs/idea/06-protocol-translation.md#error-shapes`). `errors/render.ts`
 * owns the two shapes and the router's *own* failures; this module owns the other half — reading a
 * body somebody else wrote and handing it across the seam.
 *
 * **Nothing here takes an Account.** Not as a parameter, not for a better message: the identity of
 * the account that failed never reaches a client, and a signature that cannot receive it cannot
 * leak it (`docs/idea/07-security.md`). The upstream's own message is passed through because it is
 * the only diagnostic the caller has, but it is scrubbed with the log redactor first — an upstream
 * is free to quote a key back at us, and this body is a client-facing surface. `redactValue` is the
 * redactor's pure string half, not a logger: the design rule this module still obeys is "no clock,
 * no store, no network, no logger", and one scrubbing regex set is better than two that drift.
 *
 * The rendered `type` is derived from the HTTP status rather than copied from the upstream. The
 * vocabularies are per-dialect — `invalid_request_error` is spelled the same in both, `overloaded_error`
 * and `server_error` are not — and a foreign type name in the wrong dialect is a lie a client will
 * branch on. The status is the one signal both dialects agree on; the upstream's own type survives
 * in the best-effort `code` field wherever the target shape has room for it.
 */

const MAX_MESSAGE_CHARS = 512

/** A body larger than this is a proxy's HTML page, not an error object; it is not parsed. */
const MAX_BODY_CHARS = 64 * 1024

const codeValue = z.union([z.string(), z.number()]).nullish().catch(null)

/** Anthropic nests under `error` and adds an outer `type:"error"`; OpenAI nests under `error`. One
 * shape reads both, plus the bare-string form several compatible upstreams emit. */
const nestedError = z.looseObject({
  error: z.union([
    z.string(),
    z.looseObject({
      message: z.string().nullish().catch(null),
      type: z.string().nullish().catch(null),
      code: codeValue,
    }),
  ]),
})

/** Some upstreams put the message at the top level with no envelope at all. */
const flatError = z.looseObject({
  message: z.string().nullish().catch(null),
  type: z.string().nullish().catch(null),
  code: codeValue,
})

export interface UpstreamErrorDetail {
  /** Always populated: an unreadable body falls back to a message derived from the status alone. */
  readonly message: string
  readonly type: string | null
  readonly code: string | null
}

/**
 * Read `{message, type, code}` out of whatever the upstream sent.
 *
 * Accepts a parsed object or the raw body text, so a caller holding bytes does not have to guess
 * whether the upstream honored its own content type. Never throws.
 */
export function parseUpstreamError(body: unknown, status: number): UpstreamErrorDetail {
  const detail = extract(decode(body))
  return {
    message: clean(detail?.message ?? null, status),
    type: blankToNull(detail?.type ?? null),
    code: blankToNull(detail?.code ?? null),
  }
}

/**
 * An upstream error body → the ingress dialect's error body.
 *
 * The HTTP status is the upstream's own and is not remapped here: deciding whether a `401` from a
 * provider becomes a `502` to the client is a routing decision, and routing has already made it by
 * the time a body needs rendering.
 */
export function translateUpstreamError(body: unknown, status: number, ingress: Dialect): ErrorBody {
  const detail = parseUpstreamError(body, status)
  return renderErrorBody(ingress, status, detail.message, detail.code ?? detail.type)
}

interface RawDetail {
  readonly message: string | null
  readonly type: string | null
  readonly code: string | null
}

/** A string body is JSON until proven otherwise; markup is proven otherwise on sight. */
function decode(body: unknown): unknown {
  if (typeof body !== "string") return body
  const trimmed = body.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_BODY_CHARS) return null
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return trimmed.startsWith("<") ? null : { message: trimmed }
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function extract(body: unknown): RawDetail | null {
  const nested = nestedError.safeParse(body)
  if (nested.success) {
    const inner = nested.data.error
    if (typeof inner === "string") return { message: inner, type: null, code: null }
    return { message: inner.message ?? null, type: inner.type ?? null, code: text(inner.code) }
  }

  const flat = flatError.safeParse(body)
  if (!flat.success) return null
  return {
    message: flat.data.message ?? null,
    type: flat.data.type ?? null,
    code: text(flat.data.code),
  }
}

function text(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return typeof value === "number" ? String(value) : value
}

function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? ""
  return trimmed.length === 0 ? null : trimmed
}

/**
 * The message a client sees: redacted, trimmed, bounded, and never empty.
 *
 * The bound is not cosmetic. An upstream can answer with a stack trace or a whole HTML page, and a
 * client-facing error body is the wrong place to relay an unbounded string from a third party.
 */
function clean(raw: string | null, status: number): string {
  const scrubbed = redactValue(raw ?? "").trim()
  if (scrubbed.length === 0) return `Upstream request failed with status ${status}`
  if (scrubbed.length <= MAX_MESSAGE_CHARS) return scrubbed
  return `${scrubbed.slice(0, MAX_MESSAGE_CHARS - 1)}…`
}
