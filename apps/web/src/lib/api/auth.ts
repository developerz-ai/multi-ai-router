import { request } from "./client"
import { adoptSession, clearSession } from "./session"
import type { SessionView } from "./types"

// `/api/admin/auth`. The only group mounted outside the admin guard, because
// login is what issues the session it would otherwise require.
//
// Each call folds its result into the session state itself: a caller that has
// to remember to call `adoptSession` after `login` is a caller that will one day
// forget and leave every mutation without a CSRF token.

export interface Credentials {
  readonly username: string
  readonly password: string
}

export async function login(credentials: Credentials): Promise<SessionView> {
  const session = await request<SessionView>({
    method: "POST",
    path: "/auth/login",
    body: credentials,
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
