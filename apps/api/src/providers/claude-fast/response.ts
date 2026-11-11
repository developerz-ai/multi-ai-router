import { z } from "zod"
import { readErrorBody, sanitizeErrorBody } from "../../services/dataplane/error-body"
import { createSseParser, frameJson } from "../../services/translate/sse/parse"
import { classifySdkFailure, type SdkFailure } from "../claude-sdk/errors"
import { FORCED_TOOL_UNMET } from "../claude-sdk/failure-rules-request"
import { createMessageFold } from "../claude-sdk/render/message"

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

/** Only a non-streaming caller pays for a fold. Streaming callers receive the upstream body. */
export async function collectFastResponse(
  response: Response,
  signal: AbortSignal,
  requireToolUse = false,
): Promise<Response> {
  const reader = response.body?.getReader()
  if (!reader) return safeError(502, "Claude returned no response body")
  const parser = createSseParser()
  const fold = createMessageFold()
  let stopped = false
  let started = false
  let invalid = false
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
  if (invalid || !started || !stopped || openBlocks.size > 0 || fold.failed())
    return safeError(502, "Claude ended the response before completion")
  const body = fold.body()
  if (requireToolUse && !hasToolUse(body.content)) throw new FastForcedToolUnmet()
  return Response.json(body)
}

function hasToolUse(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (block) => typeof block === "object" && block !== null && block.type === "tool_use",
    )
  )
}

/**
 * Provider error prose can echo credentials. Classify privately and expose only router-authored
 * text. The classification — whose `message` is the upstream's words with the selected Account's
 * own token and every pattern-shaped credential redacted — rides beside the Response
 * ({@link fastFailureOf}) so the attempt log can quote it (`dataplane/attempt-log.ts`) while the
 * client body stays the router's sentence.
 */
export async function sanitizeFastError(
  response: Response,
  maxBytes: number,
  secrets: readonly string[] = [],
): Promise<Response> {
  return fastErrorResponse(response, await readFastErrorText(response, maxBytes, secrets))
}

/** The upstream's error prose, bounded and with the Account's token and credential shapes redacted. */
export async function readFastErrorText(
  response: Response,
  maxBytes: number,
  secrets: readonly string[] = [],
): Promise<string> {
  return sanitizeErrorBody(await readErrorBody(response, maxBytes), secrets)
}

/** The client-safe Response for an already-read, already-redacted upstream error. */
export function fastErrorResponse(response: Response, text: string): Response {
  const failure = classifySdkFailure({ message: text, apiErrorStatus: response.status })
  const status =
    failure.classification.kind === "unknown" ? response.status : failure.classification.status
  const safe = safeError(status, failure.clientMessage, response.headers.get("retry-after"))
  FAST_FAILURES.set(safe, failure)
  return safe
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

/**
 * Keyed weakly by the sanitized Response the invoker returned, so nothing outlives the attempt that
 * produced it — the pattern of `errors/router-object.ts`'s request facts. The `SdkInvoker` contract
 * stays a plain `Response`; only the attempt seam (`dataplane/sdk-attempt-response.ts`) reads this.
 */
const FAST_FAILURES = new WeakMap<Response, SdkFailure>()

export function fastFailureOf(response: Response): SdkFailure | undefined {
  return FAST_FAILURES.get(response)
}
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
