import { z } from "zod"
import { readErrorBody, sanitizeErrorBody } from "../../services/dataplane/error-body"
import { createSseParser, frameJson } from "../../services/translate/sse/parse"
import { classifySdkFailure, type SdkFailure } from "../claude-sdk/errors"
import { FORCED_TOOL_UNMET } from "../claude-sdk/failure-rules-request"
import { createMessageFold } from "../claude-sdk/render/message"
import { refusedModelClaim } from "./quota"

const frame = z.looseObject({
  type: z.string(),
  index: z.number().int().nonnegative().optional(),
})
const message = z.looseObject({
  id: z.string().min(1),
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string(),
  content: z.array(z.looseObject({ type: z.string() })),
})

/**
 * A forced tool the fast transport relaxed to `auto` (`tool-choice.ts`) and the model did not call.
 * Its own class so the invoker's catch passes it through instead of rewrapping it as a transport
 * failure; the sentence is the Agent-SDK transport's, so `failure-rules-request.ts` classifies it
 * as `claude-sdk:forced-tool-unmet` — a retryable `502`.
 */
export class FastForcedToolUnmet extends Error {
  constructor() {
    super(FORCED_TOOL_UNMET)
  }
}

/** An `error` frame the upstream sent in place of the rest of an answer it had begun with a `200`. */
export interface FastStreamError {
  /** The HTTP status Anthropic answers the same error with when it refuses before the stream. */
  readonly status: number
  readonly body: string
}

/**
 * Only a non-streaming caller pays for a fold. Streaming callers receive the upstream body.
 *
 * `onStreamError` answers an upstream `error` frame: no byte has reached this client, so it is the
 * refusal the same error would have been as a status — an `overloaded_error` read as a generic `502`
 * struck the breaker of an Account that was never at fault.
 */
export async function collectFastResponse(
  response: Response,
  signal: AbortSignal,
  requireToolUse = false,
  onStreamError?: (error: FastStreamError) => Response,
): Promise<Response> {
  const reader = response.body?.getReader()
  if (!reader) return safeError(502, "Claude returned no response body")
  const parser = createSseParser()
  const fold = createMessageFold()
  let stopped = false
  let started = false
  let invalid = false
  let streamError: FastStreamError | null = null
  const seenBlocks = new Set<number>()
  const openBlocks = new Set<number>()
  const consume = (frames: ReturnType<typeof parser.push>) => {
    for (const event of frames) {
      const parsed = frame.safeParse(frameJson(event))
      if (!parsed.success) {
        invalid = true
        continue
      }
      const data = parsed.data
      if (data.type === "ping") continue
      if (data.type === "error") {
        streamError ??= readStreamError(data)
        continue
      }
      if (stopped) invalid = true
      if (data.type === "message_start") {
        if (started || !message.safeParse(data.message).success) invalid = true
        started = true
      } else if (!started) invalid = true
      if (data.type === "content_block_start") {
        if (data.index === undefined || seenBlocks.has(data.index)) invalid = true
        else {
          seenBlocks.add(data.index)
          openBlocks.add(data.index)
        }
      }
      if (
        data.type === "content_block_delta" &&
        (data.index === undefined || !openBlocks.has(data.index))
      )
        invalid = true
      if (data.type === "content_block_stop") {
        if (data.index === undefined || !openBlocks.delete(data.index)) invalid = true
      }
      if (data.type === "message_stop") {
        if (openBlocks.size > 0) invalid = true
        stopped = true
      }
      fold.push([parsed.data])
    }
  }
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      consume(parser.push(chunk.value))
    }
    consume(parser.flush())
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (streamError !== null && !stopped && onStreamError !== undefined)
    return onStreamError(streamError)
  if (streamError !== null || invalid || !started || !stopped || openBlocks.size > 0)
    return safeError(502, "Claude ended the response before completion")
  const body = fold.body()
  if (requireToolUse && !hasToolUse(body.content)) throw new FastForcedToolUnmet()
  return Response.json(body)
}

/**
 * Anthropic's error types and the status each is documented to answer with. An unlisted one is the
 * `500` its own `api_error` is.
 */
const STREAM_ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
}

function readStreamError(data: Record<string, unknown>): FastStreamError {
  const type: unknown =
    typeof data.error === "object" && data.error !== null ? Reflect.get(data.error, "type") : null
  const status = typeof type === "string" ? STREAM_ERROR_STATUS[type] : undefined
  return { status: status ?? 500, body: JSON.stringify(data) }
}

function hasToolUse(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (block) => typeof block === "object" && block !== null && block.type === "tool_use",
    )
  )
}

/** The upstream's error prose, bounded and with the Account's token and credential shapes redacted. */
export async function readFastErrorText(
  response: Response,
  maxBytes: number,
  secrets: readonly string[] = [],
): Promise<string> {
  return sanitizeErrorBody(await readErrorBody(response, maxBytes), secrets)
}

/**
 * An already-read, already-redacted upstream error: the private classification, whose `message` is
 * the upstream's scrubbed words for the attempt log, and the client-safe Response carrying only
 * router-authored text — provider error prose can echo credentials. The classification travels by
 * `SdkInvocation.onRefusal`, never on the Response.
 */
export function fastRefusal(
  upstream: { readonly status: number; readonly headers: Headers },
  text: string,
): { readonly failure: SdkFailure; readonly response: Response } {
  const read = classifySdkFailure({ message: text, apiErrorStatus: upstream.status })
  const failure = withModelScope(read, upstream.headers)
  const { classification } = failure
  const status = classification.kind === "unknown" ? upstream.status : failure.classification.status
  return {
    failure,
    response: safeError(status, failure.clientMessage, upstream.headers.get("retry-after")),
  }
}

/** A spent model-family window holds that model on this Account, never the Account. */
function withModelScope(failure: SdkFailure, headers: Headers): SdkFailure {
  const { classification } = failure
  if (classification.kind !== "rate-limited" || classification.requestAttributable === true)
    return failure
  const refused = refusedModelClaim(headers)
  if (refused === null) return failure
  const reset = refused.resetsAt
  return {
    ...failure,
    classification: {
      ...classification,
      modelScoped: true,
      rateLimit: {
        limited: false,
        resetSource: reset === undefined ? "unknown" : "provider-reported",
        windows: [],
        ...(reset === undefined ? {} : { resetsAt: reset }),
      },
    },
  }
}

/**
 * Anthropic refusing the native `output_config.format` schema itself rather than the request: the
 * prod sentences of 101 finding 10.4 — `Schema is too complex.`, `Grammar compilation timed out`,
 * and `output_config.format.schema: … is not supported`. Only these send the invoker back to the
 * adapted structured-output tool; any other `400` is the request's own and is relayed.
 */
export function isNativeSchemaRejection(status: number, text: string): boolean {
  return status === 400 && NATIVE_SCHEMA_REJECTION.test(text)
}
const NATIVE_SCHEMA_REJECTION =
  /schema is too complex|grammar compilation|output_config\.format(?:\.schema)?\b/i

function safeError(status: number, message: string, retryAfter?: string | null): Response {
  return Response.json(
    { type: "error", error: { type: "api_error", message } },
    { status, ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}) },
  )
}

/** A proxy's HTML/JSON success must never be relayed as an Anthropic event stream. */
export async function validateFastResponse(response: Response): Promise<Response> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType === "text/event-stream" && response.body !== null) return response
  await response.body?.cancel()
  return safeError(502, "Claude returned an invalid event stream")
}
