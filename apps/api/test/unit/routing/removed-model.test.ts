import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import { providerRoutingVariants } from "../../../src/providers/registry"
import { type CatalogSources, loadCatalog } from "../../../src/services/catalog"
import { logRemovedModelRefusal } from "../../../src/services/dataplane/removed-model-log"
import { type AccountSnapshot, selectAccounts } from "../../../src/services/routing"
import { accountRow } from "../../support/account-row"
import { account, snapshot } from "./fixtures"

/**
 * A refusal for an id that was on the account's list until recently names the edit that removed
 * it. Prod 2026-11-15: an id dropped from `supportedModels` by a "Discover models" overwrite was
 * refused `model-unsupported` ~320 tasks over 19 h, each refusal telling the client to change its
 * model, and nothing pointed at the edit.
 */

const NOW = new Date("2026-11-20T12:00:00.000Z")
const REMOVED_AT = new Date("2026-11-15T05:38:00.000Z")
const MODEL = "deepseek/deepseek-v4.1-flash-0925"

function removedFrom(label: string, overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return account(label, {
    provider: "openrouter",
    supportedModels: ["deepseek/deepseek-v4.1-flash"],
    removedModels: new Map([[MODEL, { at: REMOVED_AT, by: "admin-api-token (discover-script)" }]]),
    ...overrides,
  })
}

function refuse(accounts: readonly AccountSnapshot[], model = MODEL) {
  const selection = selectAccounts(snapshot([...accounts]), {
    sessionKey: "s",
    model,
    keyScope: { kind: "accounts", accountIds: accounts.map((entry) => entry.id) },
    rotationCounter: 0,
  })
  if (selection.ok) throw new Error("expected a refusal")
  return selection
}

describe("a model-unsupported refusal for a recently removed id", () => {
  test("the error says when it was removed and by whom", () => {
    const { error } = refuse([removedFrom("openrouter-dz-coding")])
    expect(error.message).toBe(
      `no account serves model "${MODEL}" — "${MODEL}" was removed from openrouter-dz-coding's supported models at 2026-11-15T05:38:00.000Z by admin-api-token (discover-script) (1 account in scope: openrouter-dz-coding)`,
    )
  })

  test("the rejection carries the removal as data", () => {
    const { decision } = refuse([removedFrom("openrouter-dz-coding")])
    expect(decision.rejected[0]).toMatchObject({
      reason: "model-unsupported",
      removedFromList: { model: MODEL, at: REMOVED_AT, by: "admin-api-token (discover-script)" },
    })
  })

  test("a routing variant of a removed base id is explained by the base's removal", () => {
    const variants = providerRoutingVariants("openrouter")
    const { decision } = refuse(
      [removedFrom("openrouter-dz-coding", { routingVariants: variants })],
      `${MODEL}:floor`,
    )
    expect(decision.rejected[0]?.removedFromList?.model).toBe(MODEL)
  })

  test("an id never on the list is still a client change", () => {
    const { error } = refuse([removedFrom("openrouter-dz-coding")], "nobody/never-listed")
    expect(error.message).toContain("— a client change (")
    expect(error.message).not.toContain("was removed")
  })

  test("one warn line per refused account names the removal", () => {
    const refused = refuse([removedFrom("or-a"), account("or-b", { supportedModels: ["x"] })])
    const lines: { message: string; fields?: Record<string, unknown> }[] = []
    logRemovedModelRefusal(
      { warn: (message, fields) => void lines.push({ message, ...(fields ? { fields } : {}) }) },
      refused,
      MODEL,
    )
    expect(lines).toEqual([
      {
        message: "model refused: removed from the account's supported models",
        fields: {
          component: "dataplane",
          model: MODEL,
          accountId: refused.decision.rejected[0]?.accountId,
          label: "or-a",
          removedModel: MODEL,
          removedAt: REMOVED_AT.toISOString(),
          removedBy: "admin-api-token (discover-script)",
        },
      },
    ])
  })
})

describe("loadCatalog carries recent removals into the snapshot", () => {
  const DAY = 86_400_000
  function sources(rows: readonly AccountRow[]): CatalogSources {
    return {
      read: async () => ({
        accounts: [...rows],
        pools: [],
        members: [],
        windows: [],
        recoveries: [],
      }),
    }
  }

  test("a removal inside the window is carried; one past it is not", async () => {
    const row = accountRow({
      provider: "openrouter",
      supportedModels: ["a"],
      supportedModelsRemoved: [
        { model: "recent", removedAt: new Date(NOW.getTime() - DAY).toISOString(), by: "x" },
        { model: "old", removedAt: new Date(NOW.getTime() - 40 * DAY).toISOString(), by: "y" },
      ],
    })
    const { accounts } = await loadCatalog(sources([row]), {
      now: () => NOW,
      memoryMs: 30 * DAY,
    })
    const removed = accounts[0]?.snapshot.removedModels
    expect([...(removed?.keys() ?? [])]).toEqual(["recent"])
    expect(removed?.get("recent")).toEqual({ at: new Date(NOW.getTime() - DAY), by: "x" })
  })

  test("no removals leaves the field absent", async () => {
    const { accounts } = await loadCatalog(sources([accountRow({ supportedModels: ["a"] })]))
    expect(accounts[0]?.snapshot.removedModels).toBeUndefined()
  })
})
