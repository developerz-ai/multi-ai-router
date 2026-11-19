import type { Context, MiddlewareHandler } from "hono"
import {
  ADMIN_ACTOR_HEADER,
  type AdminRequestCaller,
  ANONYMOUS_ACTOR,
  adminRequestAuditContext,
  runWithAuditContext,
} from "../services/admin/audit-context"
import type { AppEnv } from "../types"
import { requestClientIp } from "./clientIp"
import { noteAdminCaller } from "./logger"

/**
 * The transport half of the audit context (multi-ai-router#453): reads who and where off one admin
 * request and runs the rest of it under that caller, so every audit row it causes names them. The
 * rules for the strings themselves live in `services/admin/audit-context.ts`.
 *
 * Admin plane only. Nothing on `/v1/**` mounts this — the data plane's budget is not spent on
 * bookkeeping it never writes.
 */
export function runAsAdminCaller<E extends AppEnv>(
  c: Context<E>,
  caller: Pick<AdminRequestCaller, "actor" | "actorKind">,
  trustedHops: number,
  next: () => Promise<void>,
): Promise<void> {
  const context = adminRequestAuditContext({
    ...caller,
    declaredActor: c.req.header(ADMIN_ACTOR_HEADER),
    clientIp: requestClientIp(c, trustedHops),
    userAgent: c.req.header("user-agent"),
    requestId: c.get("requestId"),
  })
  // The request's transport line names the same caller, refused or not (`logger.ts`).
  noteAdminCaller(c.req.raw, context)
  return runWithAuditContext(context, next)
}

/**
 * The sign-in routes, which no guard fronts because they are what issues a session. An attempt is
 * `anonymous`, with the address it came from; a guarded route below this (`/logout`) nests its own
 * session context inside and wins.
 */
export function signInAuditContext<E extends AppEnv>(trustedHops: number): MiddlewareHandler<E> {
  return (c, next) =>
    runAsAdminCaller(c, { actor: ANONYMOUS_ACTOR, actorKind: "anonymous" }, trustedHops, next)
}
