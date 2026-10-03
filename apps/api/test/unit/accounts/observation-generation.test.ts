import { expect, test } from "bun:test"
import { accountRow } from "../../support/account-row"
import { memoryAccountLifecycle } from "../../support/memory-account-lifecycle"

test("memory lifecycle observations share the current recovery map and fence newer generations", async () => {
  const original = accountRow()
  const rows = [original]
  const recoveries = new Map([[original.id, { generation: "new-generation" }]])
  const repo = memoryAccountLifecycle(rows, [], recoveries)
  for (const generation of [null, "old-generation"]) {
    expect(
      await repo.transitionObservedStatus({
        id: original.id,
        expected: { ...original, recoveryGeneration: generation },
        status: "exhausted",
        now: new Date(),
      }),
    ).toBeUndefined()
  }
  expect(
    await repo.transitionObservedStatus({
      id: original.id,
      expected: { ...original, recoveryGeneration: "new-generation" },
      status: "cooling_down",
      now: new Date(),
    }),
  ).toMatchObject({ status: "cooling_down" })
})
