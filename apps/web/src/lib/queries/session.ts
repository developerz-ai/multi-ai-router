import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import { type Credentials, fetchSession, login, logout } from "../api/auth"
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

export function useLogin() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (credentials: Credentials) => login(credentials),
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
