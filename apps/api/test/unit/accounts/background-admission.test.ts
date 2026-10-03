import { expect, test } from "bun:test"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"
import { createBackgroundStartGuard } from "../../../src/services/accounts/background-admission"
import { accountRow } from "../../support/account-row"

test("guard retains the original identity across queued waits", async () => {
  const row = accountRow({ lifecycleVersion: 2, authMaterial: "old", configDir: "/old" })
  let checked: unknown,
    warmChecks = 0
  const guard = createBackgroundStartGuard(
    {
      accounts: {
        readEligibleBackgroundAccount: async (_id, expected) => {
          checked = expected
          return undefined
        },
      },
      assertWarmEligibility: () => {
        warmChecks++
      },
    },
    row,
  )
  row.lifecycleVersion = 3
  row.authMaterial = "new"
  row.configDir = "/new"
  await expect(guard()).rejects.toBeInstanceOf(UpstreamAdmissionRefused)
  expect(checked).toMatchObject({ lifecycleVersion: 2, authMaterial: "old", configDir: "/old" })
  expect(warmChecks).toBe(0)
})
test("warm quota refusal is checked after the authoritative read completes", async () => {
  const read = Promise.withResolvers<ReturnType<typeof accountRow>>()
  const entered = Promise.withResolvers<void>()
  const row = accountRow()
  let spent = false,
    warmChecks = 0
  const guard = createBackgroundStartGuard(
    {
      accounts: {
        readEligibleBackgroundAccount: async () => {
          entered.resolve()
          return read.promise
        },
      },
      assertWarmEligibility: () => {
        warmChecks++
        if (spent) throw new UpstreamAdmissionRefused("quota spent")
      },
    },
    row,
  )
  const outcome = guard().catch((error) => error)
  await entered.promise
  spent = true
  read.resolve(row)
  expect(await outcome).toBeInstanceOf(UpstreamAdmissionRefused)
  expect(warmChecks).toBe(1)
})
test("database failures fail closed without logging credential-bearing SQL details", async () => {
  const messages: unknown[] = []
  const guard = createBackgroundStartGuard(
    {
      accounts: {
        readEligibleBackgroundAccount: async () => {
          throw new Error("SQL parameters: secret")
        },
      },
      assertWarmEligibility: () => {
        throw new Error("must not run")
      },
      logger: {
        warn: (message, fields) => {
          messages.push({ message, fields })
        },
      },
    },
    accountRow(),
  )
  await expect(guard()).rejects.toBeInstanceOf(UpstreamAdmissionRefused)
  expect(JSON.stringify(messages)).not.toContain("secret")
  expect(messages).toHaveLength(1)
})
test("cancellation during the authority read prevents final warm admission", async () => {
  const read = Promise.withResolvers<ReturnType<typeof accountRow>>()
  const entered = Promise.withResolvers<void>()
  const controller = new AbortController()
  let warmChecks = 0
  const row = accountRow()
  const guard = createBackgroundStartGuard(
    {
      accounts: {
        readEligibleBackgroundAccount: async () => {
          entered.resolve()
          return read.promise
        },
      },
      assertWarmEligibility: () => {
        warmChecks++
      },
    },
    row,
    controller.signal,
  )
  const outcome = guard().catch((error) => error)
  await entered.promise
  controller.abort()
  read.resolve(row)
  expect(await outcome).toBeInstanceOf(UpstreamAdmissionRefused)
  expect(warmChecks).toBe(0)
})
