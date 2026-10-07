import { expect, test } from "bun:test"
import { createWarmBackgroundStartGuard } from "../../../src/composition/background-admission"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"
import { accountRow } from "../../support/account-row"
import { account, NOW } from "../dataplane/fixtures"

function fixture() {
  const row = accountRow()
  const current = account(row.id, { provider: row.provider })
  let present = true
  const catalog = { accounts: () => (present ? [current] : []) }
  let live = current.snapshot
  let accepting = true
  const pending = Promise.withResolvers<typeof row>()
  const entered = Promise.withResolvers<void>()
  const guard = createWarmBackgroundStartGuard(
    {
      accounts: {
        readEligibleBackgroundAccount: async () => {
          entered.resolve()
          return pending.promise
        },
      },
      catalog,
      access: { currentSnapshot: () => live },
      now: () => NOW,
      quotaSpentThreshold: 0.95,
      accepting: () => accepting,
    },
    { ...row, authMaterial: current.authMaterial },
  )
  return {
    guard,
    pending,
    entered,
    row,
    current,
    setLive: (value: typeof live) => {
      live = value
    },
    remove: () => {
      present = false
    },
    stop: () => {
      accepting = false
    },
  }
}
test("background launch refuses late shutdown after the DB read began", async () => {
  const f = fixture()
  const result = f.guard().catch((error) => error)
  await f.entered.promise
  f.stop()
  f.pending.resolve(f.row)
  expect(await result).toBeInstanceOf(UpstreamAdmissionRefused)
})
test("background launch refuses late warm status and identity changes", async () => {
  for (const mutation of ["status", "identity"] as const) {
    const f = fixture()
    const result = f.guard().catch((error) => error)
    await f.entered.promise
    if (mutation === "status") f.setLive({ ...f.current.snapshot, status: "exhausted" })
    else Object.assign(f.current, { lifecycleVersion: 100 })
    f.pending.resolve(f.row)
    expect(await result).toBeInstanceOf(UpstreamAdmissionRefused)
  }
})

test("ordinary background admission rejects absent, spent and locally available recovery accounts", async () => {
  for (const policy of ["absent", "spent", "issued"] as const) {
    const f = fixture()
    const result = f.guard().catch((error) => error)
    await f.entered.promise
    if (policy === "absent") f.remove()
    if (policy === "spent")
      f.setLive({
        ...f.current.snapshot,
        quotaWindows: [
          {
            window: "five_hour",
            utilization: 1,
            utilizationSource: "continuous",
            resetSource: "unknown",
            lastCheckedAt: NOW,
          },
        ],
      })
    if (policy === "issued")
      f.setLive({
        ...f.current.snapshot,
        recovery: {
          state: "issued",
          localAvailable: true,
          revision: 1,
          generation: "g",
          lifecycleVersion: 0,
          quotaRevisions: {},
          nextAllowedAt: NOW,
        },
      })
    f.pending.resolve(f.row)
    expect(await result).toBeInstanceOf(UpstreamAdmissionRefused)
  }
})

test("ordinary background admission passes a pending or settled-uncertain recovery", async () => {
  const base = { revision: 1, generation: "g", lifecycleVersion: 0, quotaRevisions: {} }
  for (const recovery of [
    { ...base, state: "pending" as const, nextAllowedAt: new Date(NOW.getTime() + 60_000) },
    { ...base, state: "uncertain" as const, nextAllowedAt: new Date(NOW.getTime() - 1) },
  ]) {
    const f = fixture()
    const result = f.guard().then(
      () => "admitted",
      (error) => error,
    )
    await f.entered.promise
    f.setLive({ ...f.current.snapshot, recovery })
    f.pending.resolve(f.row)
    expect(await result).toBe("admitted")
  }
})

test("ordinary background admission holds an uncertain recovery inside its next allowed instant", async () => {
  const f = fixture()
  const result = f.guard().catch((error) => error)
  await f.entered.promise
  f.setLive({
    ...f.current.snapshot,
    recovery: {
      state: "uncertain",
      revision: 1,
      generation: "g",
      lifecycleVersion: 0,
      quotaRevisions: {},
      nextAllowedAt: new Date(NOW.getTime() + 60_000),
    },
  })
  f.pending.resolve(f.row)
  expect(await result).toBeInstanceOf(UpstreamAdmissionRefused)
})
