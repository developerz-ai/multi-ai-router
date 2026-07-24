import { request } from "./client"
import type { ProviderDescriptor, ProviderListResponse } from "./types"

// `/api/admin/providers`, read-only. The "add account" form is built from this
// and never from a hard-coded list: adding a provider must touch exactly one
// file under `apps/api/src/providers/`, and a second copy of the list here
// would make it two.
//
// This is the one list endpoint that wraps its array in an object; every other
// group answers with a bare array. The unwrap is done here so no caller has to
// know which convention a given group follows.

export async function listProviders(): Promise<readonly ProviderDescriptor[]> {
  const body = await request<ProviderListResponse>({ method: "GET", path: "/providers" })
  return body.providers
}

/** Only providers with an implementation may back a new account. */
export function creatableProviders(
  providers: readonly ProviderDescriptor[],
): readonly ProviderDescriptor[] {
  return providers.filter((provider) => provider.creatable)
}

export function findProvider(
  providers: readonly ProviderDescriptor[],
  id: string,
): ProviderDescriptor | undefined {
  return providers.find((provider) => provider.id === id)
}
