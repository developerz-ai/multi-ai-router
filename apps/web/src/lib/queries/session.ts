import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import { fetchAuthMethods, fetchSession, login, logout } from "../api/auth"
import { queryKeys } from "./query-keys"

/**
 * Who is signed in.
 *
 * `retry: false` because the failure this query exists to detect is a 401, and
 * retrying a 401 only delays the redirect to the login screen by a round trip.
 * Every other query in the console keeps the client default of one retry.
 */
export function useSession() {
  return useQuery(() => ({
    queryKey: queryKeys.session(),
    queryFn: () => fetchSession(),
    retry: false,
    staleTime: 60_000,
  }))
}

/**
 * Which sign-in doors this router offers — SSO, the local password, or both.
 * The login page is the only reader: it renders what this says and nothing
 * more, so a deployment with no local credential never shows a password box.
 *
 * The key is local to this module rather than in `query-keys.ts`: the value is
 * server configuration, not a resource the console mutates, so nothing ever
 * needs to invalidate it by prefix.
 */
export function useAuthMethods() {
  return useQuery(() => ({
    queryKey: ["session", "auth-methods"] as const,
    queryFn: () => fetchAuthMethods(),
    retry: false,
    staleTime: 60_000,
  }))
}

/**
 * The local password door. On success the returned session is already adopted
 * (see `lib/api/auth.ts`); this fills the session cache with it so the shell
 * does not re-ask and flash the login screen during the navigation the caller
 * is about to make.
 */
export function useLocalLogin() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (password: string) => login(password),
    onSuccess: (session) => {
      client.setQueryData(queryKeys.session(), session)
    },
  }))
}

/**
 * Signing out clears the whole cache, not just the session key. Accounts, keys
 * and pools were read under the identity that just ended; leaving them in memory
 * would flash the previous operator's fleet behind the next login form.
 */
export function useLogout() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: () => logout(),
    onSuccess: () => {
      client.clear()
    },
  }))
}
