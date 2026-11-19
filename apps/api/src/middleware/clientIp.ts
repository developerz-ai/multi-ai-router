import type { Context } from "hono"
import { getConnInfo } from "hono/bun"
import { clientIp } from "../services/admin-auth"

/**
 * The address the sign-in throttle and every audit row count against — one resolution, so one
 * caller always lands in one bucket and on one row. The rule (`TRUST_PROXY`, `TRUST_PROXY_HOPS`) is
 * `services/admin-auth/clientIp.ts`; this is only the transport half that finds the socket peer.
 *
 * `trustedHops` is `TRUST_PROXY_HOPS` when `TRUST_PROXY` is on and `0` otherwise
 * (`trustedProxyHops`), so an unvetted `X-Forwarded-For` is never read.
 */
export function requestClientIp(c: Context, trustedHops: number): string {
  let socketAddress: string | undefined
  try {
    socketAddress = getConnInfo(c).remote.address
  } catch {
    // No Bun server behind this request — an `app.request(...)` call in a test. Every such
    // caller shares one bucket, which is the conservative direction to be wrong in.
    socketAddress = undefined
  }
  return clientIp(c.req.header("x-forwarded-for"), socketAddress, trustedHops)
}

/** `TRUST_PROXY` off means no proxy hop is trusted, whatever `TRUST_PROXY_HOPS` says. */
export function trustedProxyHops(trustProxy: boolean, trustProxyHops: number): number {
  return trustProxy ? trustProxyHops : 0
}
