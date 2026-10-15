import { expect, test } from "bun:test"
import { catalogLabels } from "../../../src/services/usage-read/labels"

const row = (id: string, name: string) => ({ id, name, owner: null, ownerKind: null, tool: null })

/**
 * The label loader feeds the usage filter's owner/tool resolution, so its read order is
 * load-bearing: live keys first, tombstones second. A delete commits its tombstone in the same
 * transaction that removes the row, so with this order a key is always in at least one of the two
 * reads. Run in parallel, a delete landing between them could drop the key from both.
 */
test("tombstones are read only after the live key read has resolved", async () => {
  let release: (rows: ReturnType<typeof row>[]) => void = () => {}
  let tombstoneCalls = 0
  const labels = catalogLabels({
    keys: {
      list: () => new Promise((resolve) => (release = resolve as typeof release)) as never,
    },
    tombstones: {
      listAll: async () => {
        tombstoneCalls += 1
        return [row("gone", "purged")] as never
      },
    },
    catalog: { accounts: () => [], pools: () => [] },
  })
  const pending = labels()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(tombstoneCalls).toBe(0)
  release([row("live", "kept")])
  const loaded = await pending
  expect(tombstoneCalls).toBe(1)
  expect([...loaded.keys.keys()].sort()).toEqual(["gone", "live"])
})
