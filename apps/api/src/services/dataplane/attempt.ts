import type { Dialect } from "@multi-ai-router/core"
import type {
  FailureClassification,
  ProviderDriver,
  RateLimitSignal,
  UpstreamFailureKind,
} from "../../providers"
import type { CredentialCipher } from "../crypto/cipher"
import { type AttemptFailure, classifyStatus, type FailureKind } from "../routing"
import { accountCredential } from "./egress/credential"
import { upstreamHeaders } from "./egress/headers"
import type { FetchLike, RoutableAccount } from "./types"

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
  /** The client's own abort signal, so a client that goes away releases the upstream call. */
  readonly signal?: AbortSignal
}

/** What the upstream said, when it said something the client should see. */
export interface UpstreamError {
  readonly status: number
  readonly headers: Headers
  readonly bodyText: string
  readonly contentType: string | null
}

export type AttemptOutcome =
  | {
      readonly kind: "success"
      readonly response: Response
      readonly rateLimit: RateLimitSignal | null
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
  const credential = accountCredential(plan.account, input.cipher)
  const headers = upstreamHeaders(
    input.clientHeaders,
    plan.driver.buildHeaders(plan.account.driver, credential),
  )

  const request = new Request(plan.url.toString(), {
    method: input.method,
    headers,
    ...(input.body === null ? {} : { body: input.body }),
    signal: deadline(input.timeoutMs, input.signal),
  })

  let response: Response
  try {
    response = await input.fetch(request)
  } catch (error) {
    return {
      kind: "failure",
      failure: transportFailure(error),
      classification: null,
      rateLimit: null,
      upstream: null,
    }
  }

  const rateLimit = plan.driver.parseRateLimit({
    status: response.status,
    headers: response.headers,
  })

  if (response.status < 400) {
    return { kind: "success", response, rateLimit }
  }

  const bodyText = await readBodyText(response)
  const classification = plan.driver.classifyFailure({
    status: response.status,
    headers: response.headers,
    body: parseJson(bodyText),
  })

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

/** The driver's vocabulary mapped onto failover's. `unknown` falls back to what the status says. */
const FAILURE_KINDS: Readonly<Record<UpstreamFailureKind, FailureKind | null>> = {
  "rate-limited": "rate-limited",
  "credits-exhausted": "credits-exhausted",
  auth: "auth",
  "invalid-request": "client-error",
  "server-error": "server-error",
  unknown: null,
}

function toAttemptFailure(
  status: number,
  classification: FailureClassification | null,
  rateLimit: RateLimitSignal | null,
): AttemptFailure {
  const mapped = classification === null ? null : FAILURE_KINDS[classification.kind]
  const kind = mapped ?? classifyStatus(status) ?? "server-error"
  const signal = classification?.rateLimit ?? rateLimit

  return {
    kind,
    status,
    resetsAt: signal?.resetsAt,
    retryAfterSeconds: signal?.retryAfterSeconds,
    resetSource: signal?.resetSource,
    message: classification?.signal ?? `upstream returned ${status}`,
  }
}

function transportFailure(error: unknown): AttemptFailure {
  const name = error instanceof Error ? error.name : ""
  const timedOut = name === "TimeoutError" || name === "AbortError"
  return {
    kind: timedOut ? "timeout" : "connection",
    message: timedOut
      ? "upstream did not answer within its deadline"
      : "upstream connection failed",
  }
}

/** The upstream call is bounded, and a client that disconnects releases it immediately. */
function deadline(timeoutMs: number, client: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return client === undefined ? timeout : AbortSignal.any([timeout, client])
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ""
  }
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
