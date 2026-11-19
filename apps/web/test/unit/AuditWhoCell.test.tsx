import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import type { AuditEvent } from "../../src/lib/api/audit"
import { AuditWhoCell } from "../../src/routes/settings/AuditWhoCell"

/**
 * The audit log's "Who" cell (multi-ai-router#456), rendered. What the operator reads first is what
 * the caller called itself, then the credential's own name, and for a row written before the router
 * recorded callers, a plain "not recorded" — never an empty cell that reads as a rendering bug.
 *
 * `container` is queried directly and removed after: happy-dom's `document` is one global shared by
 * every test file in this process.
 */

function event(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "e1",
    kind: "pool.updated",
    subjectType: "pool",
    subjectId: null,
    detail: null,
    createdAt: "2026-11-18T21:57:00.000Z",
    actor: null,
    actorKind: null,
    actorSays: null,
    clientIp: null,
    userAgent: null,
    requestId: null,
    ...over,
  }
}

function withCell(row: AuditEvent, run: (cell: HTMLElement) => void): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => <AuditWhoCell event={row} />, container)
  try {
    run(container)
  } finally {
    dispose()
    container.remove()
  }
}

const CALLER = {
  actor: "admin-api-token",
  actorKind: "api_token",
  clientIp: "203.0.113.9",
  userAgent: "dz-router-client/1",
} as const

describe("the Who cell", () => {
  test("shows what the caller said it was, first", () => {
    withCell(event({ ...CALLER, actorSays: "agent ops-seat-slice02 for sebyx07" }), (cell) => {
      expect(cell.textContent).toContain("agent ops-seat-slice02 for sebyx07")
      expect(cell.textContent).not.toContain("not recorded")
    })
  })

  test("falls back to the actor when the caller declared nothing", () => {
    withCell(event({ ...CALLER }), (cell) => {
      expect(cell.textContent).toContain("admin-api-token")
      expect(cell.textContent).not.toContain("not recorded")
    })
  })

  test("says 'not recorded' for a row written before callers were recorded", () => {
    withCell(event(), (cell) => {
      expect(cell.textContent).toContain("not recorded")
    })
  })

  test("its tooltip holds the actor, the kind, the address and the user agent", () => {
    withCell(event({ ...CALLER, actorSays: "agent ops-seat-slice02 for sebyx07" }), (cell) => {
      const title = cell.querySelector("[title]")?.getAttribute("title") ?? ""
      expect(title).toContain("admin-api-token")
      expect(title).toContain("api_token")
      expect(title).toContain("203.0.113.9")
      expect(title).toContain("dz-router-client/1")
    })
  })

  test("a 200-character name is carried whole in the tooltip, for the cell to truncate", () => {
    const long = "a".repeat(200)
    withCell(event({ ...CALLER, actorSays: long }), (cell) => {
      const label = cell.querySelector("[title]")
      expect(label?.textContent).toBe(long)
      expect(label?.getAttribute("title")).toContain(long)
    })
  })
})
