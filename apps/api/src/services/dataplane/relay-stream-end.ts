import type { Dialect } from "@multi-ai-router/core"
import { type ErrorBody, refusalBody } from "../../errors/render"
import type { RouterVerdict } from "../../errors/router-object"
import { encodeSseEvent } from "../translate"
import { RouterShutdownError } from "./active-requests"

/**
 * A client stream that breaks **after** its first byte ends with one router error event, never a
 * cut connection.
 *
 * Failover is over once a byte is on the wire (`chain.ts`), so the upstream that broke cannot be
 * swapped for a sibling. What the client is still owed is the reason, in the shape its SDK already
 * reads as an error: Anthropic's `event: error`, OpenAI chat's error chunk then `[DONE]`, the
 * Responses `error` event. Each carries `router` (`errors/router-object.ts`), so a `200` stream
 * that stopped early is never a silent truncation. A client that went away is owed nothing: its
 * stream errors as before.
 *
 * The event opens with a blank line: if the upstream broke mid-event, that ends the fragment
 * before ours starts; at an event boundary, an empty line dispatches nothing.
 *
 * Only a transport fault reaches here. An error the upstream itself sent in-stream is relayed as
 * it came (non-negotiable 10), and a translator's own error event is the translator's.
 */

export interface StreamEndFacts {
  readonly requestId: string | null
  /** The attempt that served the stream: the attempts this request made. */
  readonly attempt: number
  readonly accountId: string
}

export function endsWithRouterError(
  response: Response,
  ingress: Dialect,
  facts: StreamEndFacts,
  /** The client's own signal: once it has gone, nothing is written. */
  client: AbortSignal | undefined,
): Response {
  if (response.body === null) return response
  const reader = response.body.getReader()
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let next: Awaited<ReturnType<typeof reader.read>>
        try {
          next = await reader.read()
        } catch (error) {
          if (client?.aborted === true) {
            controller.error(error)
            return
          }
          controller.enqueue(encoder.encode(streamEndEvent(ingress, error, facts)))
          controller.close()
          return
        }
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
  return new Response(body, response)
}

const MESSAGE_TAIL = "not retried, bytes were already sent"

/** The event text for `error`, in the ingress dialect. Exported for the frozen-sentence test. */
export function streamEndEvent(ingress: Dialect, error: unknown, facts: StreamEndFacts): string {
  const shutdown = error instanceof RouterShutdownError
  const signal = shutdown
    ? "router_shutdown"
    : isTimeout(error)
      ? "upstream_timeout"
      : "upstream_error"
  const message = shutdown
    ? `the router shut down after the response began; ${MESSAGE_TAIL}`
    : `the upstream stream failed after the response began (${signal}); ${MESSAGE_TAIL}`
  const verdict: RouterVerdict = {
    wall: "capacity",
    scope: shutdown ? "router" : "account",
    signal,
    attempts: facts.attempt,
    accounts: [{ accountId: facts.accountId, state: signal }],
  }
  const status = shutdown ? 503 : signal === "upstream_timeout" ? 504 : 502
  const body = refusalBody(ingress, status, message, signal, verdict, facts.requestId)
  return `\n\n${encodeEvents(ingress, body)}`
}

function encodeEvents(ingress: Dialect, body: ErrorBody): string {
  if ("type" in body) return encodeSseEvent({ event: "error", data: JSON.stringify(body) })
  if (ingress === "openai-chat")
    return encodeSseEvent({ data: JSON.stringify(body) }) + encodeSseEvent({ data: "[DONE]" })
  // The Responses stream's `error` event is flat: `router` sits beside `code` and `message`.
  const { message, code, router } = body.error
  return encodeSseEvent({
    event: "error",
    data: JSON.stringify({ type: "error", code, message, param: null, router }),
  })
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error ? error.name === "TimeoutError" : false
}
