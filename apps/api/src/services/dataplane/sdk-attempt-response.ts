import type { RateLimitSignal } from "../../providers"
import { type AttemptOutcome, failoverKind } from "./attempt"
import type { SdkAttemptInput } from "./sdk-attempt"
/**
 * The same `Response`, with `release` called once the body is finished with — drained, cancelled by
 * a client that went away, or errored.
 *
 * **The body is the signal on purpose, rather than a callback the transport fires.** The claim is
 * held for exactly as long as the SDK session is producing this answer, and the rendered stream *is*
 * that production: reading it off the body cannot be forgotten by an invoker, where a callback on
 * the `SdkInvocation` seam silently degrades every later turn of every conversation the moment one
 * implementation neglects it. A body-less response releases immediately, which is the same claim
 * with nothing left to produce.
 *
 * The gauge that outlives `result` by one bounded control request is knowingly outside this window
 * (docs/idea/11-anthropic-agent-sdk.md §9). A concurrent turn landing inside it meets the CLI's own
 * refusal, which is classified and recovered in place — the backstop this was never meant to
 * replace.
 */
export function releasingWith(response: Response, release: () => void): Response {
  const body = response.body
  if (body === null) {
    release()
    return response
  }

  const reader = body.getReader()
  const observed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let step: Awaited<ReturnType<typeof reader.read>>
      try {
        step = await reader.read()
      } catch (error) {
        // A source that failed mid-stream has still stopped producing this answer.
        release()
        controller.error(error)
        return
      }
      if (step.done) {
        release()
        controller.close()
        return
      }
      controller.enqueue(step.value)
    },
    // A client that went away ends the turn as surely as one that read it to the end. Without
    // this the conversation would stay claimed until the process restarted, and every later turn
    // of it would run detached.
    cancel(reason) {
      release()
      return reader.cancel(reason)
    },
  })
  return new Response(observed, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/**
 * A fully-built error Response off the SDK renderer, reshaped into the same outcome an HTTP
 * attempt's error response produces: classified by status, the body kept so the client can still
 * be answered with the upstream's own words when no other candidate serves.
 */
export async function errorResponseFailure(
  response: Response,
  rateLimit: RateLimitSignal | null,
): Promise<AttemptOutcome> {
  let bodyText = ""
  try {
    bodyText = await response.text()
  } catch {
    // An unreadable body leaves the status to speak for itself.
  }
  return {
    kind: "failure",
    failure: {
      kind: failoverKind(null, response.status),
      status: response.status,
      // Router-authored (docs/idea/07-security.md): the SDK body is relayed as an *upstream*
      // answer where relaying is safe, but this sentence is what a router-shaped error renders.
      message: "the Claude Agent SDK turn ended in an upstream error",
    },
    classification: null,
    rateLimit,
    upstream: {
      status: response.status,
      headers: response.headers,
      bodyText,
      contentType: response.headers.get("content-type"),
    },
  }
}

/**
 * Folds every `rate_limit_event` of one attempt into Account quota state, and remembers the
 * account's whole reading afterwards — not just this event's, since a warning window earlier in the
 * same turn still belongs in what the breaker sees.
 *
 * A no-op when no store is wired: `capture` still exists so the invoker always has something to
 * call, and `signal()` reports null forever, exactly like an HTTP driver that parsed no headers.
 */
export function rateLimitCapture(
  input: SdkAttemptInput,
  accountId: string,
): { capture: (info: unknown) => void; signal: () => RateLimitSignal | null; close: () => void } {
  const { quota } = input
  let latest: RateLimitSignal | null = null
  let closed = false
  return {
    capture: (info) => {
      if (closed || quota === undefined || input.rateLimitObserver?.accepts() === false) return
      const now = input.now?.() ?? new Date()
      const snapshot = quota.ingest(accountId, info, now)
      if (snapshot !== null) {
        latest = snapshot.signal
        input.rateLimitObserver?.observe(latest, now)
      }
    },
    signal: () => latest,
    close: () => {
      closed = true
    },
  }
}
