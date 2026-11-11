import { toApiError, UNAUTHORIZED } from "./errors"
import { adoptSession, csrfToken, markSessionLost, sessionLost } from "./session"
import type { SessionView } from "./types"

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

/** A list is a repeated parameter (`?owner=a&owner=b`), which is how the usage filters are read. */
export type QueryParams = Readonly<Record<string, string | readonly string[] | undefined>>

/**
 * Pure, so the path/query assembly is testable without a network. `undefined`
 * values are dropped rather than serialised as the string "undefined" — the
 * account list filter is built from optional selects and sends nothing when the
 * operator picks "any". A list is appended once per value, never comma-joined, with its empty
 * values dropped; a list that is empty after that sends nothing.
 */
export function buildPath(path: string, query?: QueryParams): string {
  if (query === undefined) return `${ADMIN_BASE}${path}`
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    if (typeof value === "string") {
      if (value.length > 0) params.set(key, value)
      continue
    }
    for (const item of value) if (item.length > 0) params.append(key, item)
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
  if (isMutating(spec.method)) await ensureCsrfToken(spec.path)
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

/** The one mutating call that is made without a session — it is what issues one. */
const SESSIONLESS_PATHS: ReadonlySet<string> = new Set(["/auth/login"])

let pendingSession: Promise<void> | null = null

/**
 * The token arrives with `GET /auth/session`, which the shell starts on mount. An operator who
 * presses a button before that answer lands sent the mutation with no `x-csrf-token`, and the
 * guard refused a perfectly good session. Such a mutation waits for the same session read first —
 * one in flight at a time. A failed read is not raised here: the mutation goes out and the
 * server's own refusal (a `401` routes to login) is what the caller sees.
 */
async function ensureCsrfToken(path: string): Promise<void> {
  if (csrfToken() !== null || sessionLost() || SESSIONLESS_PATHS.has(path)) return
  pendingSession ??= request<SessionView>({ method: "GET", path: "/auth/session" })
    .then(
      (session) => {
        if (typeof session?.csrfToken === "string") adoptSession(session)
      },
      () => undefined,
    )
    .finally(() => {
      pendingSession = null
    })
  await pendingSession
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
