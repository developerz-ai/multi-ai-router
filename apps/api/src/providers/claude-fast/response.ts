import { z } from "zod"
import { readErrorBody } from "../../services/dataplane/error-body"
import { createSseParser, frameJson } from "../../services/translate/sse/parse"
import { classifySdkFailure } from "../claude-sdk/errors"
import { createMessageFold } from "../claude-sdk/render/message"

const frame = z.looseObject({ type: z.string() })

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
  const openBlocks = new Set<number>()
  const consume = (frames: ReturnType<typeof parser.push>) => {
    for (const event of frames) {
      const parsed = frame.safeParse(frameJson(event))
      if (!parsed.success) continue
      if (parsed.data.type === "message_start") started = true
      if (parsed.data.type === "content_block_start" && typeof parsed.data.index === "number")
        openBlocks.add(parsed.data.index)
      if (parsed.data.type === "content_block_stop" && typeof parsed.data.index === "number")
        openBlocks.delete(parsed.data.index)
      if (parsed.data.type === "message_stop") stopped = true
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
  if (!started || !stopped || openBlocks.size > 0 || fold.failed())
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
