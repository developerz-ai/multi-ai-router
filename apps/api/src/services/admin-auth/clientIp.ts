/**
 * The address the sign-in throttle and the audit row count against.
 *
 * `trustedHops` is how many proxies we run in front of the router (`TRUST_PROXY_HOPS`), or `0` when
 * `TRUST_PROXY` is off. Each of those proxies appends the address it received the connection
 * from, so the client is the entry `trustedHops` from the **right**. Everything to the left of it
 * was supplied by the client and is worth nothing: the leftmost entry is whatever the caller typed,
 * and trusting it handed every attempt a fresh throttle bucket.
 *
 * Fewer entries than hops means the request did not come through the chain the operator described,
 * so the header proves nothing and the socket peer is the answer.
 */
export function clientIp(
  forwardedFor: string | undefined,
  socketAddress: string | undefined,
  trustedHops: number,
): string {
  if (trustedHops > 0 && forwardedFor !== undefined) {
    const entries = forwardedFor.split(",").map((entry) => entry.trim())
    const candidate = entries[entries.length - trustedHops]
    if (entries.length >= trustedHops && candidate !== undefined && candidate.length > 0) {
      return candidate
    }
  }
  return socketAddress ?? UNKNOWN_CLIENT_IP
}

/** What a caller that cannot resolve a peer address records, so the field is always present. */
export const UNKNOWN_CLIENT_IP = "unknown"
