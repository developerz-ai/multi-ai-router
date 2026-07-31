import { request } from "./client"
import { adoptSession, clearSession } from "./session"
import type { SessionView } from "./types"

// `/api/admin/auth`. The only group mounted outside the admin guard, because
// signing in is what issues the session the guard would otherwise require.
//
// There are two ways in, and this module is the whole client half of both:
//   - **SSO**: the SPA navigates the browser to `/api/admin/auth/oidc/start`;
//     the IdP returns it to `/api/admin/auth/oidc/callback`; the API sets the
//     session cookie and the SPA re-loads. No credentials cross the SPA.
//   - **Local password**: the SPA POSTs the password to `/api/admin/auth/login`
//     and adopts the returned session — the same cookie, the same CSRF, the
//     same guard. Which of the two a deployment offers is a server fact, read
//     from `GET /api/admin/auth/methods` (public) — never assumed.

/** `GET /api/admin/auth/methods` — which sign-in doors this router has. */
export interface AuthMethods {
  readonly oidc: boolean
  readonly local: boolean
}

/**
 * Public and unauthenticated: the login page asks before it renders. A router
 * that cannot answer gets an error card, not a guess.
 */
export async function fetchAuthMethods(): Promise<AuthMethods> {
  return await request<AuthMethods>({ method: "GET", path: "/auth/methods" })
}

/**
 * The local password door. The answer is the same body `GET /session` returns,
 * so the session is adopted straight from the response — no second round trip.
 * A wrong password arrives as a 401 ApiError with the server's one generic
 * sentence; the form renders it verbatim.
 */
export async function login(password: string): Promise<SessionView> {
  const session = await request<SessionView>({
    method: "POST",
    path: "/auth/login",
    body: { password },
  })
  adoptSession(session)
  return session
}

/**
 * Who am I, and is this cookie still worth anything. A 401 here is the normal
 * answer for a cold load with no cookie — `request` flips `sessionLost` and the
 * shell routes to the login screen.
 */
export async function fetchSession(): Promise<SessionView> {
  const session = await request<SessionView>({ method: "GET", path: "/auth/session" })
  adoptSession(session)
  return session
}

/**
 * Mutating, so it carries a CSRF token like any other action. The local state is
 * cleared whatever the server said: a logout that fails server-side must still
 * not leave a stale token in this tab.
 */
export async function logout(): Promise<void> {
  try {
    await request<{ readonly status: string }>({ method: "POST", path: "/auth/logout" })
  } finally {
    clearSession()
  }
}
