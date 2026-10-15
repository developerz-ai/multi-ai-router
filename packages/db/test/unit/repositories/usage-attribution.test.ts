import { describe, expect, test } from "bun:test"
import type { Database } from "../../../src/client"
import { createUsageHistoryRepository } from "../../../src/repositories/usage-history-repository"
import { createUsageReadRepository } from "../../../src/repositories/usage-read-repository"

/**
 * The types make an owner/tool read without a key attribution unrepresentable. The runtime throw is
 * the backstop for a caller that casts past them: it must fail loudly, before any SQL is issued,
 * never fold every key into the deleted bucket. No database is touched, so a bare stub suffices.
 */
const db = {} as Database
const window = { from: new Date("2026-01-01"), to: new Date("2026-01-02") }
const bypass = (value: string) => value as never

describe("owner and tool reads without a key attribution", () => {
  for (const dimension of ["owner", "tool"]) {
    test(`history breakdown(${dimension}) throws`, async () => {
      const history = createUsageHistoryRepository(db)
      await expect(
        (history.breakdown as (...args: unknown[]) => Promise<unknown>)(
          window,
          bypass(dimension),
          10,
          {},
        ),
      ).rejects.toThrow("requires a key attribution")
    })
    test(`history seriesByDimension(${dimension}) throws`, async () => {
      const history = createUsageHistoryRepository(db)
      await expect(
        (history.seriesByDimension as (...args: unknown[]) => Promise<unknown>)(
          window,
          "day",
          bypass(dimension),
          1,
          undefined,
          {},
        ),
      ).rejects.toThrow("requires a key attribution")
    })
    test(`raw breakdown(${dimension}) throws`, async () => {
      const raw = createUsageReadRepository(db)
      await expect(
        (raw.breakdown as (...args: unknown[]) => Promise<unknown>)(
          window,
          bypass(dimension),
          undefined,
          10,
          {},
        ),
      ).rejects.toThrow("requires a key attribution")
    })
    test(`raw seriesByDimension(${dimension}) throws`, async () => {
      const raw = createUsageReadRepository(db)
      await expect(
        (raw.seriesByDimension as (...args: unknown[]) => Promise<unknown>)(
          window,
          "day",
          bypass(dimension),
          {},
        ),
      ).rejects.toThrow("requires a key attribution")
    })
  }
})
