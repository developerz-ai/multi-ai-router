import { InvalidRequestError, type RouterError } from "@multi-ai-router/core"
import type { Logger } from "../../logging/logger"
import type { RateLimitSignal, SdkFailure, SdkInvocation } from "../../providers"
import { toRouterError } from "../../providers/failure/router-error"
import { parseRetryAfter } from "../../providers/rate-limit/parse"
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
 *
 * A fast-transport refusal (`claude-fast/response.ts`) also carries its private classification.
 * Its signal and scrubbed upstream text go to the attempt log as `upstreamSignal` and
 * `upstreamMessage`, and its `requestAttributable` / `permanentForRequest` ride the failure, as on
 * the Agent-SDK path (`sdk-attempt.ts`): without them the breaker read a request-provoked `429` as
 * the account's and cooled it (prod 2026-11-20, `claude-sdk:extra-usage-gated`). When that
 * classification is `invalid-request`, the attempt also gets a router verdict: the fast body is
 * only a sentence the router wrote, so it is rendered as the router's own `InvalidRequestError`,
 * which carries `error.router` with `wall: "request"`. A `rate-limited` or `overloaded` refusal is
 * rendered the same way, through `toRouterError`, so the client reads the router's own `429` or
 * `503` with its `Retry-After` instead of a relayed sentence the router wrote (#508). Every other
 * kind keeps its status-shaped verdict: handing it to `classification` would render it through
 * `toRouterError` instead (`chain-error.ts`) and change what the client reads for a `401` or `402`.
 *
 * The refusal's own `retry-after` is read for this verdict alone, by the HTTP path's parser
 * (`rate-limit/parse.ts`). It is never passed to `onRateLimit` (`rateLimitCapture`), so it does not
 * reach the account's quota reading.
 */
export async function errorResponseFailure(
  response: Response,
  rateLimit: RateLimitSignal | null,
  /** What the transport said of this very answer (`SdkInvocation.onRefusal`). */
  fast?: SdkFailure,
  /** The attempt's clock and the operator's wait for a refusal that names none, for the verdict. */
  verdictContext: VerdictContext = { now: new Date() },
): Promise<AttemptOutcome> {
  const reset = fast?.classification.rateLimit
  const refusal = fast?.classification.kind === "invalid-request" ? fast : undefined
  let bodyText = ""
  try {
    bodyText = await response.text()
  } catch {
    // An unreadable body leaves the status to speak for itself.
  }
  return {
    kind: "failure",
    failure: {
      // The refusal's own kind, where the transport knows one: a 403 for one model is not the
      // request's fault, and a status alone would end the chain on it.
      kind: failoverKind(fast?.classification.kind ?? null, response.status),
      status: response.status,
      // Router-authored (docs/idea/07-security.md): the SDK body is relayed as an *upstream*
      // answer where relaying is safe, but this sentence is what a router-shaped error renders.
      message: fast?.clientMessage ?? "the Claude Agent SDK turn ended in an upstream error",
      ...(fast === undefined ? {} : { signal: fast.classification.signal }),
      ...(fast?.classification.requestAttributable === true ? { requestAttributable: true } : {}),
      ...(fast?.classification.permanentForRequest === true ? { permanentForRequest: true } : {}),
      // A window that meters one model family holds that model, not the account.
      ...(fast?.classification.modelScoped === true
        ? { modelScoped: true, resetsAt: reset?.resetsAt, resetSource: reset?.resetSource }
        : {}),
    },
    classification: refusal?.classification ?? null,
    rateLimit,
    upstream: {
      status: response.status,
      headers: response.headers,
      bodyText,
      contentType: response.headers.get("content-type"),
    },
    ...(fast === undefined ? {} : { upstreamSignal: fast.classification.signal }),
    ...(fast?.classification.message === undefined
      ? {}
      : { upstreamMessage: fast.classification.message }),
    ...verdictOf(refusal, fast, response, rateLimit, verdictContext),
  }
}

export interface VerdictContext {
  readonly now: Date
  readonly unknownResetRetryAfterSeconds?: number
}

function verdictOf(
  refusal: SdkFailure | undefined,
  fast: SdkFailure | undefined,
  response: Response,
  rateLimit: RateLimitSignal | null,
  context: VerdictContext,
): { readonly verdict?: RouterError } {
  if (refusal !== undefined)
    return {
      verdict: new InvalidRequestError(refusal.clientMessage, {
        detail: { scope: "account", signal: refusal.classification.signal },
      }),
    }
  const kind = fast?.classification.kind
  if (fast === undefined || (kind !== "rate-limited" && kind !== "overloaded")) return {}
  const stated = parseRetryAfter(response.headers)
  const usable = stated.seconds !== undefined || stated.at !== undefined
  const verdict = toRouterError(fast.classification, {
    // A header the upstream stated is a reading for this verdict alone (see the note above).
    signal: usable
      ? {
          limited: false,
          windows: [],
          ...rateLimit,
          ...(stated.seconds === undefined ? {} : { retryAfterSeconds: stated.seconds }),
          // The later of the reading's reset and the header's, as `latestResetDeadline` keeps.
          ...(stated.at === undefined ? {} : { resetsAt: laterOf(stated.at, rateLimit?.resetsAt) }),
          resetSource: rateLimit?.resetSource ?? "provider-reported",
        }
      : rateLimit,
    now: context.now,
    ...(context.unknownResetRetryAfterSeconds === undefined
      ? {}
      : { unknownResetRetryAfterSeconds: context.unknownResetRetryAfterSeconds }),
    clientMessage: fast.clientMessage,
  })
  return verdict === null ? {} : { verdict }
}

function laterOf(left: Date, right: Date | undefined): Date {
  return right !== undefined && right > left ? right : left
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

/**
 * The turn stopped mid-answer. Logged here because the render layer is pure — this seam is where the
 * account and the request id meet it — and logged with everything the renderer knew, because the
 * question this line has to answer is *which* early ending it was: the query iterator completing, a
 * `result` landing mid-block, or the subprocess dying under it.
 */
export function truncatedTurnLog(
  log: Logger | undefined,
  accountId: string,
): NonNullable<SdkInvocation["onTruncatedTurn"]> {
  return (detail) =>
    log?.warn("sdk turn ended mid-answer; the client is told it is incomplete", {
      accountId,
      blocks: detail.blocks,
      kinds: detail.kinds,
      lastMessage: detail.lastMessage,
      lastEvent: detail.lastEvent,
      sawResult: detail.sawResult,
      lastSystemSubtype: detail.lastSystemSubtype,
      // Which of the two explanations for a `tool_use` block that never closed applies —
      // see `SdkTruncatedTurn`.
      declaredTools: detail.declaredTools,
      passthrough: detail.passthrough,
      flushedBlocks: detail.flushedBlocks,
      sdkMessages: detail.sdkMessages,
      frames: detail.frames,
    })
}
