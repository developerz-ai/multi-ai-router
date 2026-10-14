import { describe, expect, test } from "bun:test"
import { createAuditRecorder } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import {
  createKeyBody,
  createKeysService,
  keyListQuery,
  updateKeyBody,
} from "../../../src/services/keys"
import { createMemoryStore } from "../../support/memory-store"

/**
 * Attribution labels on router keys: `owner`, `ownerKind`, `tool`, `purpose`.
 *
 * These are labels for usage attribution only — no login, no role, no effect on
 * request authentication (issue #219). The tests below lock the write contract:
 * slugs for owner/tool, a bounded free-text purpose, and `null` as the explicit
 * clear on PATCH.
 */

const NOW = new Date("2026-07-24T12:00:00.000Z")

function harness() {
  const store = createMemoryStore()
  const service = createKeysService({
    mutations: store.mutations,
    onCommitted: () => {},
    keys: store.keys,
    cipher: createCredentialCipher({ key: new Uint8Array(32).fill(3) }),
    audit: createAuditRecorder(store.audit),
    now: () => NOW,
  })
  return { service, store }
}

describe("owner and tool are lowercase slugs", () => {
  test("accepts lowercase letters, digits, dots, underscores and dashes", () => {
    for (const slug of ["sebastian", "ci.agent-3", "a_1", "0", "a"]) {
      expect(createKeyBody.safeParse({ name: "k", owner: slug }).success).toBe(true)
      expect(createKeyBody.safeParse({ name: "k", tool: slug }).success).toBe(true)
    }
  })

  test("rejects uppercase, a leading dash, an empty string, and 65 characters", () => {
    const sixtyFive = "a".repeat(65)
    for (const slug of ["Sebastian", "-lead", "shÖrt", "", sixtyFive]) {
      expect(createKeyBody.safeParse({ name: "k", owner: slug }).success).toBe(false)
      expect(updateKeyBody.safeParse({ tool: slug }).success).toBe(false)
    }
  })

  test("a filter value follows the same rule — the query param is a boundary too", () => {
    expect(keyListQuery.safeParse({ owner: "sebastian", tool: "aider" }).success).toBe(true)
    expect(keyListQuery.safeParse({ owner: "Sebastian" }).success).toBe(false)
    expect(keyListQuery.safeParse({ tool: "-x" }).success).toBe(false)
  })
})

describe("ownerKind", () => {
  test("is person or service, and nothing else", () => {
    expect(createKeyBody.safeParse({ name: "k", ownerKind: "person" }).success).toBe(true)
    expect(createKeyBody.safeParse({ name: "k", ownerKind: "service" }).success).toBe(true)
    expect(createKeyBody.safeParse({ name: "k", ownerKind: "team" }).success).toBe(false)
  })
})

describe("purpose", () => {
  test("is trimmed to at most 500 characters", () => {
    const parsed = createKeyBody.safeParse({ name: "k", purpose: "  nightly evals  " })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.purpose).toBe("nightly evals")

    expect(createKeyBody.safeParse({ name: "k", purpose: "p".repeat(500) }).success).toBe(true)
    expect(createKeyBody.safeParse({ name: "k", purpose: "p".repeat(501) }).success).toBe(false)
  })

  test("an empty string after trimming is stored as null, not as an empty label", () => {
    for (const blank of ["", "   "]) {
      const parsed = createKeyBody.safeParse({ name: "k", purpose: blank })
      expect(parsed.success).toBe(true)
      if (parsed.success) expect(parsed.data.purpose).toBeNull()
    }
  })
})

describe("the write schemas stay strict", () => {
  test("unknown fields are rejected on both create and update", () => {
    expect(createKeyBody.safeParse({ name: "k", ownerId: "sebastian" }).success).toBe(false)
    expect(updateKeyBody.safeParse({ owner_id: "sebastian" }).success).toBe(false)
  })

  test("PATCH null clears every attribution field", () => {
    const parsed = updateKeyBody.safeParse({
      owner: null,
      ownerKind: null,
      tool: null,
      purpose: null,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.owner).toBeNull()
      expect(parsed.data.ownerKind).toBeNull()
      expect(parsed.data.tool).toBeNull()
      expect(parsed.data.purpose).toBeNull()
    }
  })
})

describe("attribution round-trips through the service", () => {
  test("create stores the four labels and every view carries them", async () => {
    const { service, store } = harness()
    // Through the schema, as the route does: trimming happens at the boundary.
    const created = await service.create(
      createKeyBody.parse({
        name: "sebastian-laptop",
        owner: "sebastian",
        ownerKind: "person",
        tool: "claude-code",
        purpose: "  daytime coding  ",
      }),
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value).toMatchObject({
      owner: "sebastian",
      ownerKind: "person",
      tool: "claude-code",
      purpose: "daytime coding",
    })
    expect(store.rows.keys[0]).toMatchObject({ owner: "sebastian", tool: "claude-code" })

    const listed = await service.list()
    expect(listed.ok && listed.value[0]?.owner).toBe("sebastian")
    const one = await service.get(created.value.id)
    expect(one.ok && one.value.tool).toBe("claude-code")
  })

  test("omitted labels are null, never undefined or an empty string", async () => {
    const { service } = harness()
    const created = await service.create({ name: "bare" })
    expect(created.ok && created.value.owner).toBeNull()
    expect(created.ok && created.value.ownerKind).toBeNull()
    expect(created.ok && created.value.tool).toBeNull()
    expect(created.ok && created.value.purpose).toBeNull()
  })

  test("PATCH null clears a label; a missing field leaves it alone", async () => {
    const { service } = harness()
    const key = await service.create({
      name: "ci-agent-3",
      owner: "ci",
      ownerKind: "service",
      tool: "aider",
      purpose: "nightly",
    })
    if (!key.ok) throw new Error("create failed")

    const cleared = await service.update(key.value.id, { owner: null, tool: null })
    expect(cleared.ok && cleared.value.owner).toBeNull()
    expect(cleared.ok && cleared.value.tool).toBeNull()
    // Untouched fields survive a partial patch.
    expect(cleared.ok && cleared.value.ownerKind).toBe("service")
    expect(cleared.ok && cleared.value.purpose).toBe("nightly")

    const relabeled = await service.update(
      key.value.id,
      updateKeyBody.parse({ owner: "ci-2", ownerKind: "person", purpose: "  " }),
    )
    expect(relabeled.ok && relabeled.value.owner).toBe("ci-2")
    expect(relabeled.ok && relabeled.value.ownerKind).toBe("person")
    expect(relabeled.ok && relabeled.value.purpose).toBeNull()
  })

  test("the create and update audit events carry the labels", async () => {
    const { service, store } = harness()
    const key = await service.create({ name: "k", owner: "sebastian", tool: "claude-code" })
    if (!key.ok) throw new Error("create failed")
    await service.update(key.value.id, { owner: "seb" })

    const created = store.rows.audit[0]
    expect(created?.detail).toMatchObject({ owner: "sebastian", tool: "claude-code" })
    const updated = store.rows.audit.at(-1)
    expect(updated?.detail).toMatchObject({ owner: "seb" })
  })

  test("list filters by owner and tool, and the two combine", async () => {
    const { service } = harness()
    for (const body of [
      { name: "a", owner: "sebastian", tool: "claude-code" },
      { name: "b", owner: "sebastian", tool: "aider" },
      { name: "c", owner: "ci", tool: "aider" },
      { name: "d" },
    ]) {
      const created = await service.create(body)
      if (!created.ok) throw new Error(`create failed: ${created.failure.message}`)
    }

    const byOwner = await service.list({ owner: "sebastian" })
    expect(byOwner.ok && byOwner.value.map((key) => key.name)).toEqual(["a", "b"])

    const byTool = await service.list({ tool: "aider" })
    expect(byTool.ok && byTool.value.map((key) => key.name)).toEqual(["b", "c"])

    const both = await service.list({ owner: "sebastian", tool: "aider" })
    expect(both.ok && both.value.map((key) => key.name)).toEqual(["b"])

    // A filter that matches nothing is an empty list, not an error: an
    // unlabelled key simply is not in the owner's attribution set.
    const none = await service.list({ owner: "nobody" })
    expect(none.ok && none.value).toHaveLength(0)
  })
})
