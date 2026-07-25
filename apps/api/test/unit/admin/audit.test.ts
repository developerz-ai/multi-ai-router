import { describe, expect, test } from "bun:test"
import { ROUTER_KEY_PREFIX } from "@multi-ai-router/core"
import { REDACTED } from "../../../src/logging/redact"
import { AUDIT_KINDS, AUDIT_SUBJECTS, createAuditRecorder } from "../../../src/services/admin"
import { createMemoryStore } from "../../support/memory-store"

/**
 * The recorder is the single place "audit events never contain credential material" is enforced,
 * so what is tested here is that there is no way past it — not that one caller happens to pass a
 * clean detail.
 *
 * The kind strings are tested as literals for a different reason: a typo in one of them does not
 * break a build or fail a request. It writes a row the console's filter silently never shows,
 * which is the one failure mode an append-only log cannot recover from later.
 */

const NEW_KINDS = [
  AUDIT_KINDS.policyChanged,
  AUDIT_KINDS.settingsChanged,
  AUDIT_KINDS.adminLogin,
  AUDIT_KINDS.adminLoginFailed,
  AUDIT_KINDS.adminLogout,
]

function harness() {
  const store = createMemoryStore()
  return { recorder: createAuditRecorder(store.audit), rows: store.rows.audit }
}

describe("the kind and subject names", () => {
  test("are the strings the spec's audit table names, character for character", () => {
    expect(AUDIT_KINDS.policyChanged).toBe("policy.changed")
    expect(AUDIT_KINDS.settingsChanged).toBe("settings.changed")
    expect(AUDIT_KINDS.adminLogin).toBe("admin.login")
    expect(AUDIT_KINDS.adminLoginFailed).toBe("admin.login_failed")
    expect(AUDIT_KINDS.adminLogout).toBe("admin.logout")
    expect(AUDIT_SUBJECTS.settings).toBe("settings")
    expect(AUDIT_SUBJECTS.admin).toBe("admin")
  })

  test("no two kinds share a value — a duplicate is as unfilterable as a typo", () => {
    const values = Object.values(AUDIT_KINDS)
    expect(new Set(values).size).toBe(values.length)
  })

  test("a policy move is its own kind, never a spelling of pool.updated", () => {
    expect(AUDIT_KINDS.policyChanged).not.toBe(AUDIT_KINDS.poolUpdated)
  })
})

describe("subjects that have no row", () => {
  test("keep a stable id: the setting's name, the configured admin's username", async () => {
    const { recorder, rows } = harness()

    await recorder.record({
      kind: AUDIT_KINDS.settingsChanged,
      subjectType: AUDIT_SUBJECTS.settings,
      subjectId: "price_overrides",
      detail: { setting: "price_overrides" },
    })
    await recorder.record({
      kind: AUDIT_KINDS.adminLogin,
      subjectType: AUDIT_SUBJECTS.admin,
      subjectId: "admin",
      detail: { ip: "203.0.113.7" },
    })

    expect(rows.map((row) => [row.subjectType, row.subjectId])).toEqual([
      ["settings", "price_overrides"],
      ["admin", "admin"],
    ])
  })
})

describe("redaction", () => {
  test("runs over every new kind's detail, not only the ones that look risky", async () => {
    const { recorder, rows } = harness()

    for (const kind of NEW_KINDS) {
      await recorder.record({
        kind,
        subjectType: AUDIT_SUBJECTS.admin,
        subjectId: "admin",
        detail: {
          ip: "203.0.113.7",
          password: "hunter2",
          sessionToken: "s3cr3t-session",
          apiKeyCredential: "leaked",
          note: "kept",
        },
      })
    }

    expect(rows.map((row) => row.kind)).toEqual(NEW_KINDS)
    for (const row of rows) {
      expect(row.detail).toMatchObject({
        ip: "203.0.113.7",
        note: "kept",
        password: REDACTED,
        sessionToken: REDACTED,
        apiKeyCredential: REDACTED,
      })
    }

    const rendered = JSON.stringify(rows)
    expect(rendered).not.toContain("hunter2")
    expect(rendered).not.toContain("s3cr3t-session")
    expect(rendered).not.toContain("leaked")
  })

  test("scrubs a token-shaped value even under an innocent field name", async () => {
    const { recorder, rows } = harness()

    await recorder.record({
      kind: AUDIT_KINDS.settingsChanged,
      subjectType: AUDIT_SUBJECTS.settings,
      subjectId: "price_overrides",
      detail: {
        setting: "price_overrides",
        from: `${ROUTER_KEY_PREFIX}0123456789abcdef`,
        to: "sk-0123456789abcdef",
        nested: { header: "authorization: Bearer abcdefgh12345678" },
      },
    })

    const rendered = JSON.stringify(rows)
    expect(rendered).not.toContain(ROUTER_KEY_PREFIX)
    expect(rendered).not.toContain("sk-0123456789abcdef")
    expect(rendered).not.toContain("abcdefgh12345678")
    expect(rows[0]?.detail).toMatchObject({ setting: "price_overrides" })
  })

  test("an absent detail is written as null, never as an empty object", async () => {
    const { recorder, rows } = harness()

    await recorder.record({
      kind: AUDIT_KINDS.adminLogout,
      subjectType: AUDIT_SUBJECTS.admin,
      subjectId: "admin",
    })

    expect(rows[0]?.detail).toBeNull()
  })
})
