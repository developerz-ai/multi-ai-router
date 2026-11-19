import { AsyncLocalStorage } from "node:async_hooks"
import type { AuditActorKind } from "@multi-ai-router/db"
import { REDACTED, redactValue } from "../../logging/redact"

/**
 * Who is making the change the next audit row records — captured once per admin request and once
 * per scheduled task, and stamped on every row by the recorder (`./audit.ts`), so no emitter has to
 * remember to. docs/idea/08-observability.md#audit-events.
 *
 * Held in an `AsyncLocalStorage` because the emitters sit several service layers and, for pools and
 * keys, a database transaction below the request: threading a caller through every signature would
 * be the "every emitter must remember" design this replaces. Set on the admin plane and in the
 * scheduler only — never on `/v1/**`, whose budget (non-negotiable 8) it would otherwise spend.
 *
 * **Work outlives the request that started it.** Node and Bun carry the store into every timer and
 * promise created inside `run`, so a timer armed during an admin request fires — hours later —
 * still holding that operator. Background machinery that arms its own timers re-enters a system
 * context where its work starts — the credential refresher's `run()` (`services/accounts/refresh/
 * refresher.ts`) and the recovery probe's sender (`composition/recovery.ts`) — or its rows would
 * name whoever happened to trigger the arming.
 */
export interface AuditContext {
  /** The session username (SSO email), `admin-api-token`, or `system`. */
  readonly actor: string
  readonly actorKind: AuditActorKind
  /** Self-declared (`X-Admin-Actor`) or the scheduled task's name. Never authentication. */
  readonly says: string | null
  readonly clientIp: string | null
  readonly userAgent: string | null
  readonly requestId: string | null
}

const storage = new AsyncLocalStorage<AuditContext>()

export function runWithAuditContext<T>(context: AuditContext, fn: () => T): T {
  return storage.run(context, fn)
}

export function currentAuditContext(): AuditContext | undefined {
  return storage.getStore()
}

/** The `actor` of every row written by background work. */
export const SYSTEM_ACTOR = "system"

/** What a scheduled task, or other background machinery named by `says`, runs under. */
export function systemAuditContext(says: string): AuditContext {
  return {
    actor: SYSTEM_ACTOR,
    actorKind: "system",
    says,
    clientIp: null,
    userAgent: null,
    requestId: null,
  }
}

/** The header a script or agent holding the shared admin token names itself in (D1). */
export const ADMIN_ACTOR_HEADER = "x-admin-actor"

/**
 * Ceiling on the two caller-supplied strings. Not an operator knob: it bounds a column the caller
 * writes, the way the scheduler bounds its persisted error.
 */
export const AUDIT_CALLER_TEXT_MAX_CHARS = 200

/** The `actor` of a sign-in attempt: the request holds no accepted credential yet. */
export const ANONYMOUS_ACTOR = "anonymous"

/** One admin-plane request, as the transport saw it. */
export interface AdminRequestCaller {
  /** `adminSession.username`, or `ANONYMOUS_ACTOR` on a sign-in route. */
  readonly actor: string
  readonly actorKind: "session" | "api_token" | "anonymous"
  readonly declaredActor: string | undefined
  readonly clientIp: string
  readonly userAgent: string | undefined
  readonly requestId: string | undefined
}

export function adminRequestAuditContext(caller: AdminRequestCaller): AuditContext {
  return {
    actor: caller.actor,
    actorKind: caller.actorKind,
    says: callerText(caller.declaredActor, scrubDeclaredActor),
    clientIp: caller.clientIp,
    userAgent: callerText(caller.userAgent, (value) => value),
    requestId: caller.requestId ?? null,
  }
}

/**
 * The shared redactor, plus one rule only this header needs. The log redactor leaves a short
 * `Bearer x` alone because its value is too short to be a credential in a log line; a name has no
 * reason to carry an auth scheme at all, so here the scheme and whatever follows it go.
 */
function scrubDeclaredActor(value: string): string {
  return redactValue(value).replace(AUTH_SCHEME_VALUE, REDACTED)
}

const AUTH_SCHEME_VALUE = /\b(?:Bearer|Basic)\s+\S+/gi

/**
 * Trim, scrub, then cap — in that order. Capping first could cut a credential into a fragment the
 * redactor's patterns no longer recognise, and the fragment would be stored in the clear.
 */
function callerText(raw: string | undefined, scrub: (value: string) => string): string | null {
  const trimmed = raw?.trim() ?? ""
  if (trimmed.length === 0) return null
  return scrub(trimmed).slice(0, AUDIT_CALLER_TEXT_MAX_CHARS)
}
