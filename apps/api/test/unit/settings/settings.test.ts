import { describe, expect, test } from "bun:test"
import { VERSION } from "@multi-ai-router/core"
import { validate } from "../../../src/services/admin"
import { AUDIT_LIMIT_DEFAULT, auditQuery } from "../../../src/services/settings"
import { event, harness, NOW, RETENTION } from "./fixtures"

/**
 * The read side of the settings screen: environment configuration rendered exactly as the process
 * holds it, and the audit feed, which is read-only and therefore bounded rather than paged.
 */

const RATE_FIELDS = [
  "cacheReadPerMtok",
  "cacheWritePerMtok",
  "inputPerMtok",
  "model",
  "outputPerMtok",
  "provider",
]

/** A long-context row is the six above plus the prompt size its card takes over at, and nothing else. */
const TIER_FIELDS = [...RATE_FIELDS, "fromPromptTokens"].sort()

const SUBJECT = "6f1b0a3e-6d2c-4a5f-9c1e-2b7d8e4f5a60"
const OTHER_SUBJECT = "0f0e0d0c-0b0a-4908-8706-050403020100"

describe("the settings read", () => {
  test("names the build, so the console footer reports the server and not its own bundle", async () => {
    const { service } = harness()
    const result = await service.read()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(VERSION)
  })

  test("maps the env retention config through unchanged", async () => {
    const { service } = harness()
    const result = await service.read()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.retention).toEqual(RETENTION)
  })

  test("reports the log level and janitor interval the process was configured with", async () => {
    const { service } = harness()
    const result = await service.read()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.logLevel).toBe("warn")
    expect(result.value.janitorIntervalMinutes).toBe(42)
  })

  test("reports null for publicUrl when PUBLIC_URL is not configured", async () => {
    const { service } = harness()
    const result = await service.read()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.publicUrl).toBeNull()
  })

  test("reports the configured PUBLIC_URL, for the console's onboarding panel to hand out", async () => {
    const { service } = harness({ publicUrl: "https://router.example.com" })
    const result = await service.read()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.publicUrl).toBe("https://router.example.com")
  })

  test("renders the shipped price table with exactly the rate fields", async () => {
    const { service } = harness()
    const result = await service.read()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { shipped } = result.value.prices
    expect(shipped.length).toBeGreaterThan(0)
    for (const row of shipped) {
      const fields = Object.keys(row).sort()
      expect(fields).toEqual(row.fromPromptTokens === undefined ? RATE_FIELDS : TIER_FIELDS)
    }

    const sonnet = shipped.find(
      (row) => row.provider === "anthropic-api" && row.model === "claude-sonnet-5",
    )
    expect(sonnet?.inputPerMtok).toBe(3)
    expect(sonnet?.outputPerMtok).toBe(15)
  })

  test("dates the shipped table, so an operator can judge how stale it is", async () => {
    const { service } = harness()
    const result = await service.read()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A price table nobody can date is a table nobody can judge: vendors reprice without asking,
    // and the numbers ship compiled into the image.
    expect(result.value.prices.shippedAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test("a long-context tier is its own row, never a second row that hides the standard one", async () => {
    const { service } = harness()
    const result = await service.read()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const rows = result.value.prices.shipped.filter(
      (row) => row.provider === "openai-api" && row.model === "gpt-5.6-sol",
    )

    // Two rows under one name, standard first — the console folds the second onto the first as a
    // read-only annotation, which it can only do if both arrive.
    expect(rows.length).toBe(2)
    expect(rows[0]?.fromPromptTokens).toBeUndefined()
    expect(rows[1]?.fromPromptTokens).toBe(272_000)
    expect(rows[1]?.inputPerMtok).toBeGreaterThan(rows[0]?.inputPerMtok ?? 0)
  })

  test("renders each stored override with its updatedAt as an ISO string", async () => {
    const { service } = harness({
      prices: [
        {
          provider: "openrouter",
          model: "some/model",
          inputPerMtok: 1,
          outputPerMtok: 2,
          cacheReadPerMtok: 0,
          cacheWritePerMtok: 0,
        },
      ],
    })
    const result = await service.read()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.prices.overrides).toEqual([
      {
        provider: "openrouter",
        model: "some/model",
        inputPerMtok: 1,
        outputPerMtok: 2,
        cacheReadPerMtok: 0,
        cacheWritePerMtok: 0,
        updatedAt: NOW.toISOString(),
      },
    ])
  })
})

describe("the audit query bounds", () => {
  test("an absent limit takes the default", () => {
    const parsed = validate(auditQuery, {})
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.limit).toBe(AUDIT_LIMIT_DEFAULT)
  })

  test("a limit of 0 is refused rather than clamped up", () => {
    expect(validate(auditQuery, { limit: "0" }).ok).toBe(false)
  })

  test("a limit of 201 is refused rather than clamped down — a truncated page must not read as complete", () => {
    expect(validate(auditQuery, { limit: "201" }).ok).toBe(false)
    expect(validate(auditQuery, { limit: "200" }).ok).toBe(true)
    expect(validate(auditQuery, { limit: "1" }).ok).toBe(true)
  })

  test("a subjectId that is not a uuid is a 400, because it cannot name a row", () => {
    const parsed = validate(auditQuery, { subjectId: "account-3" })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.failure.status).toBe(400)
  })

  test("a well-formed subjectId and kind survive validation", () => {
    const parsed = validate(auditQuery, { subjectId: SUBJECT, kind: "account.created" })
    expect(parsed.ok).toBe(true)
    if (parsed.ok)
      expect(parsed.value).toEqual({ limit: 50, subjectId: SUBJECT, kind: "account.created" })
  })
})

describe("the audit feed", () => {
  const log = [
    event({ id: "a", kind: "account.created", createdAt: at(30), subjectId: SUBJECT }),
    event({ id: "b", kind: "key.revealed", createdAt: at(20), subjectId: OTHER_SUBJECT }),
    event({ id: "c", kind: "account.updated", createdAt: at(10), subjectId: SUBJECT }),
  ]

  function at(minutesAgo: number): Date {
    return new Date(NOW.getTime() - minutesAgo * 60_000)
  }

  test("returns newest first, echoes the limit, and renders timestamps as ISO strings", async () => {
    const { service } = harness({ auditLog: log })
    const result = await service.audit({ limit: 50 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.limit).toBe(50)
    expect(result.value.events.map((row) => row.id)).toEqual(["c", "b", "a"])
    expect(result.value.events[0]?.createdAt).toBe(at(10).toISOString())
  })

  test("honours the limit", async () => {
    const { service } = harness({ auditLog: log })
    const result = await service.audit({ limit: 2 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.events.map((row) => row.id)).toEqual(["c", "b"])
    expect(result.value.limit).toBe(2)
  })

  test("a subjectId narrows to that subject's own events", async () => {
    const { service } = harness({ auditLog: log })
    const result = await service.audit({ limit: 50, subjectId: SUBJECT })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.events.map((row) => row.id)).toEqual(["c", "a"])
  })

  test("a kind narrows the read, and still never returns more than the limit", async () => {
    const { service } = harness({ auditLog: log })
    const filtered = await service.audit({ limit: 50, kind: "account.created" })

    expect(filtered.ok).toBe(true)
    if (!filtered.ok) return
    expect(filtered.value.events.map((row) => row.id)).toEqual(["a"])

    const capped = await service.audit({ limit: 1, kind: "account.updated" })
    expect(capped.ok).toBe(true)
    if (capped.ok) expect(capped.value.events).toHaveLength(1)
  })

  test("carries the detail object through as stored — it was redacted on the way in", async () => {
    const { service } = harness({
      auditLog: [
        event({
          id: "d",
          kind: "pool.updated",
          createdAt: NOW,
          detail: { name: "team", fields: 2 },
        }),
      ],
    })
    const result = await service.audit({ limit: 50 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.events[0]?.detail).toEqual({ name: "team", fields: 2 })
  })
})
