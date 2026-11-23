import type { CredentialCipher } from "../../crypto/cipher"
import type { FetchLike, RoutableAccount } from "../types"

/** The account's proxy URL in the clear, for the one call about to use it. */
export function egressProxyUrl(
  account: Pick<RoutableAccount, "id" | "egressProxy">,
  cipher: Pick<CredentialCipher, "decrypt">,
): string | undefined {
  return account.egressProxy === undefined ? undefined : cipher.decrypt(account.egressProxy)
}

/**
 * Sends through the account's proxy, and never around it: a proxy that refuses or fails is a
 * transport failure on this account, so the chain moves to another one.
 *
 * The thrown message is fixed because a fetch failure can quote the proxy URL, password included.
 */
export async function throughProxy(
  fetch: FetchLike,
  request: Request,
  proxy: string,
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(request, { proxy })
  } catch (error) {
    if (request.signal.aborted) throw error
    throw new EgressProxyError()
  }
  // Only a proxy answers 407, so it says nothing about the account's own credential.
  if (response.status === 407) {
    void response.body?.cancel().catch(() => {})
    throw new EgressProxyError()
  }
  return response
}

export class EgressProxyError extends Error {
  override readonly name = "EgressProxyError"
  constructor() {
    super("the account's egress proxy could not complete the call")
  }
}
