/**
 * Shared plumbing for the admin CRUD plane: how a rejection is reported, how a
 * body is validated, and how a mutation is audited. Everything here is
 * transport-free and store-free.
 */

export type { AuditEventInput, AuditRecorder, AuditSink } from "./audit"
export { AUDIT_KINDS, AUDIT_SUBJECTS, createAuditRecorder, UNKNOWN_ACTOR } from "./audit"
export type { AdminRequestCaller, AuditContext } from "./audit-context"
export {
  ADMIN_ACTOR_HEADER,
  ANONYMOUS_ACTOR,
  AUDIT_CALLER_TEXT_MAX_CHARS,
  adminRequestAuditContext,
  currentAuditContext,
  runWithAuditContext,
  SYSTEM_ACTOR,
  systemAuditContext,
} from "./audit-context"
export type { CoherenceHooks } from "./coherence"
export { keyMutationCommitted, withCatalogRefresh } from "./coherence"
export { NO_NUL, noNul, readJsonBody, validate, validateId } from "./parse"
export type { AdminFailure, AdminFailureStatus, AdminResult } from "./result"
export { conflict, failureBody, invalid, notFound, ok, unavailable } from "./result"
