import { shortId } from "../format"
import { request } from "./client"

// `/api/admin/audit` — admin-plane mutations, newest first.
//
// Two properties of this log are contract rather than implementation detail:
// it is **append-only** (nothing removes a row but the janitor's retention
// sweep) and it **never contains credential material** — a key view is recorded
// as `key.viewed` with an id, never with a value
// (docs/idea/08-observability.md#audit-events). The console can therefore render
// `detail` verbatim without deciding what is safe to show.

export interface AuditEvent {
  readonly id: string
  /** The stable machine kind — `key.created`, `settings.changed`. Rendered verbatim. */
  readonly kind: string
  /** `key`, `account`, `settings`, `admin` — what kind of thing `subjectId` names. */
  readonly subjectType: string | null
  /**
   * **Not always a uuid.** A settings change names `price_overrides`, an admin
   * login names the username. Anything that shortens this has to check first.
   */
  readonly subjectId: string | null
  readonly detail: Readonly<Record<string, unknown>> | null
  readonly createdAt: string
}

export interface AuditPage {
  readonly events: readonly AuditEvent[]
  /** The limit the server actually applied, which is what the caption may quote. */
  readonly limit: number
}

export interface AuditQuery {
  readonly limit: number
  readonly kind: string | null
  readonly subjectId: string | null
}

export const AUDIT_LIMITS = [50, 100, 200] as const
export const AUDIT_LIMIT_DEFAULT = 50
const AUDIT_LIMIT_MIN = 1
const AUDIT_LIMIT_MAX = 200

/**
 * A guard on what the console may ask for, **not** a clamp: the server accepts
 * 1..200 and answers 400 outside it, so pretending a 500 becomes a 200 would put
 * a number on screen that nobody asked for and nobody sent. Anything outside the
 * accepted range falls back to the default rather than being sent and rejected.
 * The control only offers `AUDIT_LIMITS`, so this fires only for a value that
 * arrived from somewhere else.
 */
export function safeAuditLimit(limit: number): number {
  if (!Number.isInteger(limit)) return AUDIT_LIMIT_DEFAULT
  return limit >= AUDIT_LIMIT_MIN && limit <= AUDIT_LIMIT_MAX ? limit : AUDIT_LIMIT_DEFAULT
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SUBJECT_MAX = 32

/**
 * A uuid is shortened because its head identifies it; `price_overrides` and an
 * admin username are the whole fact and are printed in full. The cell carries the
 * untruncated value in its tooltip either way.
 */
export function auditSubjectText(subjectId: string): string {
  if (UUID.test(subjectId)) return shortId(subjectId)
  return subjectId.length > SUBJECT_MAX ? `${subjectId.slice(0, SUBJECT_MAX - 1)}…` : subjectId
}

export function mergeKinds(a: readonly string[], b: readonly string[]): readonly string[] {
  return [...new Set([...a, ...b])].sort()
}

/** The kinds present in one page — all a filter built from the data itself can honestly offer. */
export function auditKinds(events: readonly AuditEvent[]): readonly string[] {
  return mergeKinds(
    [],
    events.map((event) => event.kind),
  )
}

export interface DetailEntry {
  readonly key: string
  /** Truncated to fit a table cell. */
  readonly value: string
  /** The whole value, for the chip's tooltip. */
  readonly full: string
}

const DETAIL_MAX = 48

/** A detail object as `key=value` chips. Never a raw JSON dump — one long field would eat the row. */
export function auditDetailEntries(
  detail: Readonly<Record<string, unknown>> | null,
): readonly DetailEntry[] {
  if (detail === null) return []
  return Object.entries(detail).map(([key, value]) => {
    const full = stringifyDetail(value)
    const truncated = full.length > DETAIL_MAX ? `${full.slice(0, DETAIL_MAX - 1)}…` : full
    return { key, value: truncated, full }
  })
}

function stringifyDetail(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value) ?? "—"
  } catch {
    // A cyclic detail object is a bug on the API side, not a reason to blank the row.
    return "—"
  }
}

export function fetchAuditLog(query: AuditQuery): Promise<AuditPage> {
  return request<AuditPage>({
    method: "GET",
    path: "/audit",
    query: {
      limit: String(safeAuditLimit(query.limit)),
      kind: query.kind ?? undefined,
      subjectId: query.subjectId ?? undefined,
    },
  })
}
