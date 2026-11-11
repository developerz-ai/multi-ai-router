import { randomUUID } from "node:crypto"
import type { RouterError } from "@multi-ai-router/core"
import type { FailureClassification, RateLimitSignal } from "../../providers"
import { UpstreamAdmissionRefused } from "../../providers/upstream-admission"
import type { AttemptFailure } from "../routing"
import {
  attemptReading,
  failoverKind,
  redactClassification,
  toAttemptFailure,
  transportFailure,
} from "./attempt-failure"
import type { AttemptInput, UpstreamError } from "./attempt-types"
import { accountCredential } from "./egress/credential"
import { privateHeaderValues, upstreamHeaders } from "./egress/headers"
import {
  classifiableBody,
  DEFAULT_UPSTREAM_ERROR_MAX_BYTES,
  readErrorBody,
  sanitizeErrorBody,
} from "./error-body"
import { peekSuccess } from "./success-wall"
import { attemptDeadline, upstreamDeadline } from "./upstream-deadline"

export { attemptDeadline, failoverKind }

/**
 * One upstream attempt: address it, authenticate it, send it, and decide what came back.
 *
 * The response body is read **only on the failure path** — a driver needs it to tell a spent rate
 * limit from a drained balance, and every provider words that differently. A success is handed
 * back with its body untouched, because reading it would be buffering a stream.
 */

export type { AttemptInput, AttemptPlan, UpstreamError } from "./attempt-types"

export type AttemptOutcome =
  | { readonly kind: "admission-refused" }
  | {
      readonly kind: "success"
      readonly response: Response
      readonly rateLimit: RateLimitSignal | null
      /**
       * The SDK turn resumed a session carried over from the account it was bound to, so no
       * upstream context was lost and no session restart is surfaced (`session-restart.ts`).
       */
      readonly sessionCarried?: boolean
    }
  | {
      readonly kind: "failure"
      readonly failure: AttemptFailure
      readonly classification: FailureClassification | null
      readonly rateLimit: RateLimitSignal | null
      /** Present whenever the upstream answered at all. Absent on a connect failure or timeout. */
      readonly upstream: UpstreamError | null
      /**
       * The upstream's own words, already scrubbed, for the attempt log when no classification
       * carries them: the fast Claude transport keeps its verdict status-shaped and still owes the
       * operator Anthropic's sentence (`sdk-attempt-response.ts`). Never rendered to a client.
       */
      readonly upstreamMessage?: string
      /**
       * A router-authored verdict the transport decided itself, preferred over `upstream` when the
       * chain folds this attempt (`chain-error.ts`). The fast transport's own request refusal.
       */
      readonly verdict?: RouterError
      /**
       * The row's `errorClass` when the router, not the upstream, ended the attempt — or
       * {@link SUCCESS_WALL_ERROR_CLASS} when the wall was read out of an upstream `2xx`.
       */
      readonly errorClass?: string
      /**
       * The status the upstream actually answered, when `upstream.status` is not it: a wall read
       * out of a `2xx` carries the status the client is owed there, while the usage row records
       * the upstream's own (`docs/idea/08-observability.md`, `httpStatus`).
       */
      readonly answeredStatus?: number
    }

/**
 * A wall the peek read out of an upstream `2xx` (`success-wall.ts`). The row carries the status
 * the wall was owed, so without this mark it reads exactly like an upstream `4xx` and the rate of
 * walls in `2xx` cannot be counted in prod (`router_upstream_errors_total`, `usage_records`).
 */
export const SUCCESS_WALL_ERROR_CLASS = "success_wall"

export async function runAttempt(input: AttemptInput): Promise<AttemptOutcome> {
  const { plan } = input
  const credential = accountCredential(plan.account, input.cipher, plan.driver.authKind)
  const driverHeaders = plan.driver.buildHeaders(plan.account.driver, credential)
  const headers = upstreamHeaders(input.clientHeaders, driverHeaders)
  if (input.accept !== undefined) headers.set("accept", input.accept)
  if (input.cacheKey !== undefined && !driverHeaders.has(input.cacheKey[0])) {
    headers.set(input.cacheKey[0], input.cacheKey[1])
  }
  const sessionHeader = plan.driver.sessionHeader?.(plan.account.driver)
  if (sessionHeader !== undefined) headers.set(sessionHeader, input.conversationId ?? randomUUID())

  const deadline =
    input.stream === undefined
      ? undefined
      : upstreamDeadline({ stream: input.stream, client: input.signal })
  const request = new Request(plan.url.toString(), {
    method: input.method,
    headers,
    ...(input.body === null ? {} : { body: input.body }),
    signal: deadline?.signal ?? attemptDeadline(input.timeoutMs, input.signal),
    redirect: "manual",
  })

  let response: Response
  try {
    request.signal.throwIfAborted()
    input.beforeUpstreamStart?.()
    input.onUpstreamStarted?.()
    response = await input.fetch(request)
    deadline?.headersArrived()
  } catch (error) {
    deadline?.release()
    if (error instanceof UpstreamAdmissionRefused) return { kind: "admission-refused" }
    return unanswered(input, error)
  }

  // A driver hook that throws on an answer it did not expect (provider drift) must not leave the
  // attempt's clocks armed or the upstream body open; the chain records the attempt (02.7).
  try {
    return await decideAnswer(input, request, response, deadline, credential, driverHeaders)
  } catch (error) {
    deadline?.release()
    void response.body?.cancel().catch(() => {})
    throw error
  }
}

/** Reads the verdict off an answered upstream: rate limit, redirect, success peek, or failure. */
async function decideAnswer(
  input: AttemptInput,
  request: Request,
  response: Response,
  deadline: ReturnType<typeof upstreamDeadline> | undefined,
  credential: ReturnType<typeof accountCredential>,
  driverHeaders: Headers,
): Promise<AttemptOutcome> {
  const { plan } = input
  const rateLimit = plan.driver.parseRateLimit({
    status: response.status,
    headers: response.headers,
  })

  if (response.status >= 300 && response.status < 400) {
    deadline?.release()
    void response.body?.cancel().catch(() => {})
    return {
      kind: "failure",
      failure: {
        kind: "server-error",
        status: response.status,
        message: "upstream redirects are not permitted",
      },
      classification: null,
      rateLimit: null,
      upstream: null,
    }
  }

  const secret =
    credential === null
      ? null
      : credential.kind === "api-key"
        ? credential.apiKey
        : credential.accessToken
  const secrets = [
    ...new Set([...privateHeaderValues(driverHeaders), ...(secret ? [secret] : [])]),
  ].sort((a, b) => b.length - a.length)
  const errorMaxBytes = input.errorMaxBytes ?? DEFAULT_UPSTREAM_ERROR_MAX_BYTES

  if (response.status < 400) {
    // Watched first, so the idle clock bounds the peek as it bounds the relay after it.
    const watched = deadline?.watch(response) ?? response
    let peeked: Awaited<ReturnType<typeof peekSuccess>>
    try {
      const signals = [request.signal, input.abandon].filter((signal) => signal !== undefined)
      peeked = await peekSuccess(watched, {
        ...plan,
        maxBytes: errorMaxBytes,
        signal: AbortSignal.any(signals),
        ...(input.clientStreams === true && input.stream !== undefined
          ? { hold: { ms: input.stream.wallHoldMs } }
          : {}),
      })
    } catch (error) {
      deadline?.release()
      // The client left or the router is shutting down: the upstream did answer, and the chain's
      // own cancellation paths account for an answered attempt. The peek already cancelled the body.
      if (input.signal?.aborted === true || input.abandon?.aborted === true) {
        const answered = new Response(null, { status: response.status, headers: response.headers })
        return { kind: "success", response: answered, rateLimit }
      }
      return { ...unanswered(input, error), rateLimit }
    }
    if (peeked.kind === "clear") return { kind: "success", response: peeked.response, rateLimit }
    deadline?.release()
    const classification = redactClassification(peeked.classification, secrets)
    return {
      kind: "failure",
      failure: toAttemptFailure(peeked.status, classification, rateLimit),
      errorClass: SUCCESS_WALL_ERROR_CLASS,
      answeredStatus: response.status,
      classification,
      rateLimit: attemptReading(classification, rateLimit),
      upstream: {
        status: peeked.status,
        headers: response.headers,
        bodyText: sanitizeErrorBody(peeked.bodyText, secrets),
        contentType: "application/json",
      },
    }
  }
  // Watched like a success body: headers stopped the first-byte clock, so an unwatched error body
  // that went silent held the attempt until the total deadline.
  const errorBody = deadline?.watch(response) ?? response
  const bodyText = sanitizeErrorBody(
    await readErrorBody(errorBody, errorMaxBytes).finally(() => deadline?.release()),
    secrets,
  )
  const classified = plan.driver.classifyFailure({
    status: response.status,
    headers: response.headers,
    body: classifiableBody(bodyText),
  })
  const classification = classified === null ? null : redactClassification(classified, secrets)

  return {
    kind: "failure",
    failure: toAttemptFailure(response.status, classification, rateLimit),
    classification,
    rateLimit: attemptReading(classification, rateLimit),
    upstream: {
      status: response.status,
      headers: response.headers,
      bodyText,
      contentType: response.headers.get("content-type"),
    },
  }
}

/** The upstream never gave a verdict: the client left, or the transport broke or timed out. */
function unanswered(
  input: AttemptInput,
  error: unknown,
): Extract<AttemptOutcome, { kind: "failure" }> {
  return {
    kind: "failure",
    failure: input.signal?.aborted
      ? { kind: "client-error", status: 499, message: "client cancelled the request" }
      : transportFailure(error),
    classification: null,
    rateLimit: null,
    upstream: null,
  }
}
