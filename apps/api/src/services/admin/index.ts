/**
 * Shared plumbing for the admin CRUD plane: how a rejection is reported, how a
 * body is validated, and how a mutation is audited. Everything here is
 * transport-free and store-free.
 */

export type { AuditEventInput, AuditRecorder, AuditSink } from "./audit"
export { AUDIT_KINDS, AUDIT_SUBJECTS, createAuditRecorder } from "./audit"
export type { CoherenceHooks } from "./coherence"
export { withCatalogRefresh, withKeyInvalidation, withPoolCatalogRefresh } from "./coherence"
export { readJsonBody, validate, validateId } from "./parse"
export type { AdminFailure, AdminFailureStatus, AdminResult } from "./result"
export { conflict, failureBody, invalid, notFound, ok } from "./result"
