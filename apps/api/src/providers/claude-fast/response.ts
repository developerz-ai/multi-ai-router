import { z } from "zod"
import { readErrorBody } from "../../services/dataplane/error-body"
import { createSseParser, frameJson } from "../../services/translate/sse/parse"
import { classifySdkFailure } from "../claude-sdk/errors"
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

/** Only a non-streaming caller pays for a fold. Streaming callers receive the upstream body. */
export async function collectFastResponse(
  response: Response,
  signal: AbortSignal,
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
  return Response.json(fold.body())
}

/** Provider error prose can echo credentials. Classify privately and expose only router-authored text. */
export async function sanitizeFastError(response: Response, maxBytes: number): Promise<Response> {
  const text = await readErrorBody(response, maxBytes)
  const failure = classifySdkFailure({ message: text, apiErrorStatus: response.status })
  const status =
    failure.classification.kind === "unknown" ? response.status : failure.classification.status
  return safeError(status, failure.clientMessage, response.headers.get("retry-after"))
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
