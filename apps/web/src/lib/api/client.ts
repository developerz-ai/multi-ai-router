import { toApiError, UNAUTHORIZED } from "./errors"
import { csrfToken, markSessionLost } from "./session"

// The one place in the SPA that knows about `fetch`.
//
// Three rules it exists to hold, so no route has to remember them:
//
// 1. **Every mutating method carries `x-csrf-token`.** The admin guard rejects
//    one that does not (`middleware/adminAuth.ts`), and the synchronizer token
//    is the CSRF invariant the server actually enforces — `SameSite` is a
//    browser behaviour, not a guarantee.
// 2. **`credentials: "same-origin"`.** The SPA is served by the same Hono
//    process as the API, so the `__Host-` session cookie rides along and there
//    is no CORS layer anywhere.
// 3. **A 401 is a session event, not a page error.** It flips `sessionLost`
//    once, from here, so a route never has to decide whether its own 401 means
//    "log in again".

const ADMIN_BASE = "/api/admin"

/** The four verbs the admin plane speaks. */
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE"

/** Mirrors `services/admin-auth/csrf.ts`. GET is the only read. */
export function isMutating(method: HttpMethod): boolean {
  return method !== "GET"
}

export const CSRF_HEADER = "x-csrf-token"

export type QueryParams = Readonly<Record<string, string | undefined>>

/**
 * Pure, so the path/query assembly is testable without a network. `undefined`
 * values are dropped rather than serialised as the string "undefined" — the
 * account list filter is built from optional selects and sends nothing when the
 * operator picks "any".
 */
export function buildPath(path: string, query?: QueryParams): string {
  if (query === undefined) return `${ADMIN_BASE}${path}`
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value.length > 0) params.set(key, value)
  }
  const search = params.toString()
  return search.length === 0 ? `${ADMIN_BASE}${path}` : `${ADMIN_BASE}${path}?${search}`
}

/** Pure for the same reason: the CSRF rule is asserted in a unit test. */
export function buildInit(method: HttpMethod, body: unknown, token: string | null): RequestInit {
  const headers: Record<string, string> = { accept: "application/json" }
  if (body !== undefined) headers["content-type"] = "application/json"
  if (isMutating(method) && token !== null) headers[CSRF_HEADER] = token

  return {
    method,
    headers,
    credentials: "same-origin",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

export interface RequestSpec {
  readonly method: HttpMethod
  /** Relative to `/api/admin` — `"/accounts"`, `"/keys/:id/reveal"` already interpolated. */
  readonly path: string
  readonly body?: unknown
  readonly query?: QueryParams
}

/**
 * Issues one admin request and returns its parsed body, or throws an `ApiError`
 * carrying the server's own sentence.
 *
 * A body is parsed as JSON only when the response says it is JSON: an error page
 * from a proxy in front of the router is HTML, and `response.json()` on it would
 * throw a `SyntaxError` that says nothing about what actually happened.
 */
export async function request<T>(spec: RequestSpec): Promise<T> {
  const response = await fetch(buildPath(spec.path, spec.query), {
    ...buildInit(spec.method, spec.body, csrfToken()),
  })

  if (response.status === UNAUTHORIZED) {
    markSessionLost()
    throw toApiError(UNAUTHORIZED, await readBody(response))
  }

  if (!response.ok) {
    throw toApiError(response.status, await readBody(response))
  }

  return (await readBody(response)) as T
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return undefined
  try {
    return await response.json()
  } catch {
    // A truncated or empty JSON body is a failure of this response, not of the
    // caller. Returning undefined lets the error path fall back on its status.
    return undefined
  }
}
