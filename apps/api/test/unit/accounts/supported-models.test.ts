import { describe, expect, test } from "bun:test"
import {
  createAccountModelsService,
  createAccountsService,
  planSupportedModelsEdit,
} from "../../../src/services/accounts"
import { createAuditRecorder } from "../../../src/services/admin"
import { runWithAuditContext } from "../../../src/services/admin/audit-context"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { accountDeletionFixture } from "../../support/account-deletion"
import { createMemoryConfigDirs } from "../../support/config-dirs"
import { createMemoryStore } from "../../support/memory-store"
import { silentLogger } from "../../support/silent-logger"
import { testSupportedModelsWriter } from "../../support/supported-models-writer"

/**
 * The rule every `supportedModels` write obeys: an id leaves the list only when the caller named
 * it. Prod 2026-11-15: a "Discover models" overwrite dropped a hand-added id, and ~320 tasks failed
 * over 19 h on `model-unsupported` before anyone noticed.
 */

const NOW = new Date("2026-11-20T12:00:00.000Z")
const DAY = 86_400_000
const CONTEXT = { now: NOW, by: "ops@example.test", memoryMs: 30 * DAY }

describe("planSupportedModelsEdit", () => {
  test("an edit adds new ids after the existing ones and keeps every id it does not remove", () => {
    const plan = planSupportedModelsEdit(
      { supportedModels: ["a", "pinned"], supportedModelsRemoved: null },
      { kind: "edit", add: ["b", "a"], remove: [] },
      CONTEXT,
    )
    expect(plan).toMatchObject({
      ok: true,
      change: { before: ["a", "pinned"], after: ["a", "pinned", "b"], added: ["b"], removed: [] },
      removals: null,
    })
  })

  test("an edit removes exactly the ids it names, and remembers when and by whom", () => {
    const plan = planSupportedModelsEdit(
      { supportedModels: ["a", "b"], supportedModelsRemoved: null },
      { kind: "edit", add: [], remove: ["b", "never-there"] },
      CONTEXT,
    )
    expect(plan).toEqual({
      ok: true,
      change: { before: ["a", "b"], after: ["a"], added: [], removed: ["b"] },
      removals: [{ model: "b", removedAt: NOW.toISOString(), by: "ops@example.test" }],
    })
  })

  test("an id both added and removed is a contradiction, not a coin toss", () => {
    const plan = planSupportedModelsEdit(
      { supportedModels: ["a"], supportedModelsRemoved: null },
      { kind: "edit", add: ["b"], remove: ["b"] },
      CONTEXT,
    )
    expect(plan).toEqual({ ok: false, refusal: { kind: "contradictory_edit", models: ["b"] } })
  })

  test("a replace that omits an existing id without naming it is refused, naming the id", () => {
    const plan = planSupportedModelsEdit(
      { supportedModels: ["a", "pinned", "b"], supportedModelsRemoved: null },
      { kind: "replace", models: ["a", "c"], removing: ["b"] },
      CONTEXT,
    )
    expect(plan).toEqual({
      ok: false,
      refusal: { kind: "unacknowledged_removal", unnamed: ["pinned"] },
    })
  })

  test("a replace that names every id it drops lands", () => {
    const plan = planSupportedModelsEdit(
      { supportedModels: ["a", "b"], supportedModelsRemoved: null },
      { kind: "replace", models: ["a", "c"], removing: ["b"] },
      CONTEXT,
    )
    expect(plan).toMatchObject({
      ok: true,
      change: { after: ["a", "c"], added: ["c"], removed: ["b"] },
    })
  })

  test("a replace with null drops the declaration only when every id is named", () => {
    const current = { supportedModels: ["a", "b"], supportedModelsRemoved: null }
    expect(
      planSupportedModelsEdit(current, { kind: "replace", models: null, removing: ["a"] }, CONTEXT),
    ).toEqual({ ok: false, refusal: { kind: "unacknowledged_removal", unnamed: ["b"] } })
    expect(
      planSupportedModelsEdit(
        current,
        { kind: "replace", models: null, removing: ["a", "b"] },
        CONTEXT,
      ),
    ).toMatchObject({ ok: true, change: { after: null, removed: ["a", "b"] } })
  })

  test("the memory keeps recent removals, drops aged-out and re-added ones", () => {
    const plan = planSupportedModelsEdit(
      {
        supportedModels: ["a"],
        supportedModelsRemoved: [
          { model: "old", removedAt: new Date(NOW.getTime() - 31 * DAY).toISOString(), by: "x" },
          { model: "recent", removedAt: new Date(NOW.getTime() - DAY).toISOString(), by: "y" },
          { model: "back", removedAt: new Date(NOW.getTime() - DAY).toISOString(), by: "z" },
        ],
      },
      { kind: "edit", add: ["back"], remove: [] },
      CONTEXT,
    )
    if (!plan.ok) throw new Error("refused")
    expect(plan.removals?.map((entry) => entry.model)).toEqual(["recent"])
  })
})

function service() {
  const store = createMemoryStore()
  const audit = createAuditRecorder(store.audit, silentLogger())
  const writer = testSupportedModelsWriter(store.accounts, { audit, now: () => NOW })
  const configDirs = createMemoryConfigDirs()
  const accounts = createAccountsService({
    accounts: store.accounts,
    supportedModels: writer,
    keys: store.keys,
    pools: store.pools,
    cipher: createCredentialCipher({ key: new Uint8Array(32).fill(7) }),
    configDirs: configDirs.dirs,
    ...accountDeletionFixture(configDirs.dirs),
    audit,
    now: () => NOW,
  })
  return { store, accounts, models: createAccountModelsService(writer) }
}

async function seeded(models: string[]) {
  const harness = service()
  const created = await harness.accounts.create({
    label: "or-coding",
    provider: "openrouter",
    credential: "sk-or-test",
    supportedModels: models,
  })
  if (!created.ok) throw new Error(created.failure.message)
  return { ...harness, id: created.value.id }
}

describe("the account PATCH replace", () => {
  test("refuses a list that drops an id it does not name — and writes no other field", async () => {
    const { accounts, store, id } = await seeded(["a", "pinned"])

    const result = await accounts.update(id, { label: "renamed", supportedModels: ["a", "b"] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.status).toBe(409)
    expect(result.failure.code).toBe("supported_models_removal_unacknowledged")
    expect(result.failure.message).toContain('"pinned"')
    const row = await store.accounts.findById(id)
    expect(row?.supportedModels).toEqual(["a", "pinned"])
    expect(row?.label).toBe("or-coding")
  })

  test("the full list plus one is accepted — the 2026-11-20 manual fix keeps working", async () => {
    const { accounts, store, id } = await seeded(["a", "pinned"])
    const result = await accounts.update(id, { supportedModels: ["a", "pinned", "b"] })
    expect(result.ok).toBe(true)
    expect((await store.accounts.findById(id))?.supportedModels).toEqual(["a", "pinned", "b"])
  })

  test("a removal named in supportedModelsRemoving lands and is audited with the id", async () => {
    const { accounts, store, id } = await seeded(["a", "pinned"])
    const result = await runWithAuditContext(
      {
        actor: "ops@example.test",
        actorKind: "session",
        says: null,
        clientIp: null,
        userAgent: null,
        requestId: null,
      },
      () => accounts.update(id, { supportedModels: ["a"], supportedModelsRemoving: ["pinned"] }),
    )
    expect(result.ok).toBe(true)
    const event = store.rows.audit.find((row) => row.kind === "account.supported_models_changed")
    expect(event?.actor).toBe("ops@example.test")
    expect(event?.detail).toMatchObject({
      source: "account-update",
      added: [],
      removed: ["pinned"],
    })
    expect((await store.accounts.findById(id))?.supportedModelsRemoved).toEqual([
      { model: "pinned", removedAt: NOW.toISOString(), by: "ops@example.test" },
    ])
  })
})

describe("PATCH /:id/models — add one, remove one", () => {
  test("concurrent add-one calls both land", async () => {
    const { models, store, id } = await seeded(["a"])
    const [first, second] = await Promise.all([
      models.edit(id, { add: ["b"] }),
      models.edit(id, { add: ["c"] }),
    ])
    expect(first.ok && second.ok).toBe(true)
    expect((await store.accounts.findById(id))?.supportedModels).toEqual(["a", "b", "c"])
  })

  test("answers the diff, and an edit that changes nothing is not audited", async () => {
    const { models, store, id } = await seeded(["a", "b"])
    const removed = await models.edit(id, { remove: ["b"] })
    expect(removed).toEqual({
      ok: true,
      value: { accountId: id, supportedModels: ["a"], added: [], removed: ["b"] },
    })
    const before = store.rows.audit.length
    await models.edit(id, { add: ["a"] })
    expect(store.rows.audit.length).toBe(before)
  })

  test("an unknown account is a 404", async () => {
    const { models } = service()
    const result = await models.edit("00000000-0000-4000-8000-000000000000", { add: ["a"] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.status).toBe(404)
  })
})

describe("PUT /:id/models — the named full replace", () => {
  test("a replace that omits an existing id without naming it is refused", async () => {
    const { models, store, id } = await seeded(["a", "pinned"])
    const result = await models.replace(id, { models: ["a"], removing: [] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("supported_models_removal_unacknowledged")
    expect((await store.accounts.findById(id))?.supportedModels).toEqual(["a", "pinned"])
  })

  test("an id added after the client read the list cannot be dropped by its stale replace", async () => {
    const { models, store, id } = await seeded(["a", "b"])
    // Client 1 reads ["a", "b"] and plans to remove "b". Client 2 adds "c" meanwhile.
    await models.edit(id, { add: ["c"] })
    const stale = await models.replace(id, { models: ["a"], removing: ["b"] })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.failure.message).toContain('"c"')
    expect((await store.accounts.findById(id))?.supportedModels).toEqual(["a", "b", "c"])
  })
})
