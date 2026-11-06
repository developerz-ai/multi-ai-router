import { randomUUID } from "node:crypto"
import type { Dialect } from "@multi-ai-router/core"
import type { FailureClassification, ProviderDriver, RateLimitSignal } from "../../providers"
import {
  UpstreamAdmissionRefused,
  type UpstreamStartGuard,
} from "../../providers/upstream-admission"
import type { CredentialCipher } from "../crypto/cipher"
import type { AttemptFailure } from "../routing"
import {
  failoverKind,
  redactClassification,
  toAttemptFailure,
  transportFailure,
} from "./attempt-failure"
import { accountCredential } from "./egress/credential"
import { privateHeaderValues, upstreamHeaders } from "./egress/headers"
import {
  classifiableBody,
  DEFAULT_UPSTREAM_ERROR_MAX_BYTES,
  readErrorBody,
  sanitizeErrorBody,
} from "./error-body"
import { peekSuccess } from "./success-wall"
import type { FetchLike, RoutableAccount } from "./types"
import { attemptDeadline, type StreamDeadlines, upstreamDeadline } from "./upstream-deadline"

export { attemptDeadline, failoverKind }

/**
 * One upstream attempt: address it, authenticate it, send it, and decide what came back.
 *
 * The response body is read **only on the failure path** — a driver needs it to tell a spent rate
 * limit from a drained balance, and every provider words that differently. A success is handed
 * back with its body untouched, because reading it would be buffering a stream.
 */

export interface AttemptPlan {
  readonly account: RoutableAccount
  readonly driver: ProviderDriver
  readonly dialect: Dialect
  readonly url: URL
  /** The model this account expects, after its alias map. */
  readonly upstreamModel: string
}

export interface AttemptInput {
  readonly plan: AttemptPlan
  readonly method: string
  /** The client's headers, verbatim. Stripping and credential injection happen here. */
  readonly clientHeaders: Headers
  /** The opaque body. Forwarded byte for byte. */
  readonly body: Uint8Array | null
  readonly fetch: FetchLike
  readonly cipher: Pick<CredentialCipher, "decrypt">
  readonly timeoutMs: number
  /**
   * Present when the upstream answers as a stream: first-byte, idle and total clocks replace the one
   * `timeoutMs` deadline (`upstream-deadline.ts`). Absent keeps `timeoutMs` for the whole attempt.
   */
  readonly stream?: StreamDeadlines
  readonly errorMaxBytes?: number
  readonly beforeUpstreamStart?: UpstreamStartGuard
  readonly onUpstreamStarted?: () => void
  /** The client's own abort signal, so a client that goes away releases the upstream call. */
  readonly signal?: AbortSignal
  /**
   * The router abandoning the request (shutdown). Ends only the success peek: the upstream call
   * itself is left to its own clocks, and the chain answers the shutdown.
   */
  readonly abandon?: AbortSignal
  /** The client asked to stream: committed at the upstream's headers, with no peek (`success-wall.ts`). */
  readonly clientStreams?: boolean
  /**
   * Replaces the client's `Accept`. Set only for a body the router rewrote to stream for a surface
   * that answers only as SSE: the client's own value describes the response *it* is owed, not the
   * one the router asked the upstream for.
   */
  readonly accept?: string
  /**
   * The surface's prompt-cache affinity header and its value (`egress/cache-key-header.ts`). Never
   * overrides a driver header: only the selected account's driver speaks for the account.
   */
  readonly cacheKey?: readonly [string, string]
  /** For a surface that requires one (`ProviderDriver.sessionHeader`). Absent: a one-off id, as a
   * model listing or an account test is no conversation and that surface refuses none at all. */
  readonly conversationId?: string
}

/** What the upstream said, when it said something the client should see. */
export interface UpstreamError {
  readonly status: number
  readonly headers: Headers
  readonly bodyText: string
  readonly contentType: string | null
}

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
    }

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

  if (response.status < 400 && input.clientStreams === true)
    return { kind: "success", response: deadline?.watch(response) ?? response, rateLimit }
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
      classification,
      rateLimit: classification.rateLimit ?? rateLimit,
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
    rateLimit: classification?.rateLimit ?? rateLimit,
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
