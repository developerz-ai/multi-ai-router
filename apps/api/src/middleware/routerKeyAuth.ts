import type { MiddlewareHandler } from "hono"
import { presentedRouterKey, type RouterKeyVerifier, type VerifiedKey } from "../services/dataplane"
import type { AppEnv } from "../types"

/**
 * The guard on every data-plane route.
 *
 * **Both header forms are accepted, on every route.** `Authorization: Bearer mar_live_…` is what
 * OpenAI-style clients send and `x-api-key: mar_live_…` is what Anthropic-style clients send, so
 * one key works in either and the operator never has to know which dialect a tool speaks
 * (docs/idea/04-api-keys-and-access.md#accepted-in-both-dialects). Two headers carrying *different*
 * keys is a rejection, not a preference.
 *
 * Verification itself is served from an in-memory cache — the performance budget forbids a
 * database round trip per request, and a miss costs one indexed lookup, one decrypt, and one
 * constant-time compare. Anything unknown, revoked, or expired raises `KeyRevokedError` (`401`).
 *
 * The two credential spaces never overlap: an admin session cookie is not accepted here, and
 * `adminAuth` refuses a router key just as firmly in the other direction. There is deliberately no
 * code path between them.
 */

/** `AppEnv` plus the key the guard resolved. Transport-only, like `AppEnv` itself. */
export interface RouterKeyEnv extends AppEnv {
  Variables: AppEnv["Variables"] & {
    /** The verified key and its resolved scope — what selection intersects against. */
    routerKey: VerifiedKey
  }
}

export function routerKeyAuth(verifier: RouterKeyVerifier): MiddlewareHandler<RouterKeyEnv> {
  return async (c, next) => {
    const presented = presentedRouterKey(c.req.header("authorization"), c.req.header("x-api-key"))
    const key = await verifier.verify(presented)

    c.set("routerKey", key)
    // The key's id and name are safe to log; its value never is, and never appears here.
    c.set("log", c.get("log").child({ keyId: key.id, keyName: key.name }))

    await next()
  }
}
