import { describe, expect, test } from "bun:test"
import type { PriceOverrideRow } from "@multi-ai-router/db"
import { createPriceBook, lookupRates } from "../../../src/services/cost"

/**
 * The price book is the only part of cost estimation with a clock and a store behind it, so these
 * tests inject both: a loader that returns whatever the case is about and a fixed `now`. Nothing
 * here opens a connection.
 *
 * The two properties worth guarding are the ones an operator would only notice from a wrong report
 * weeks later: an override *layers over* the shipped table rather than replacing it, and a refresh
 * that fails keeps the last good snapshot instead of quietly reverting to the shipped numbers.
 */

const NOW = new Date("2026-07-25T12:00:00.000Z")

function row(overrides: Partial<PriceOverrideRow> = {}): PriceOverrideRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    provider: "anthropic-api",
    model: "claude-sonnet-5",
    inputPerMtok: 1,
    outputPerMtok: 2,
    cacheReadPerMtok: 0.5,
    cacheWritePerMtok: 4,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function bookOf(rows: readonly PriceOverrideRow[]) {
  return createPriceBook({
    load: async () => rows,
    refreshIntervalMs: 60_000,
    now: () => NOW,
    jitter: (ms) => ms,
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe("what an override changes", () => {
  test("an override wins over the shipped rate for the same model", async () => {
    const book = bookOf([row()])
    await book.refresh()

    expect(book.lookup("anthropic-api", "claude-sonnet-5")).toEqual({
      inputPerMtok: 1,
      outputPerMtok: 2,
      cacheReadPerMtok: 0.5,
      cacheWritePerMtok: 4,
    })
    // The shipped table is the fallback, not the loser of a merge: it still says what it said.
    expect(lookupRates("anthropic-api", "claude-sonnet-5")?.inputPerMtok).toBe(3)
    expect(book.loadedAt()).toEqual(NOW)
  })

  test("a model nobody overrode keeps its shipped rate", async () => {
    const book = bookOf([row()])
    await book.refresh()

    // Overriding Sonnet must not cost the deployment every other price in the table.
    expect(book.lookup("anthropic-api", "claude-haiku-4-5")?.inputPerMtok).toBe(1)
    expect(book.lookup("anthropic-api", "claude-haiku-4-5")?.outputPerMtok).toBe(5)
  })

  test("an override is scoped to its provider", async () => {
    const book = bookOf([row()])
    await book.refresh()

    // Same model name, different upstream, different contract — subscriptions share the API
    // table by default and an edit to one must not silently reprice the other.
    expect(book.lookup("anthropic-oauth", "claude-sonnet-5")?.inputPerMtok).toBe(3)
  })

  test("an override prices a provider the shipped table has no list for", async () => {
    // OpenRouter's price is whichever upstream it routed to, decided per request, so the image
    // ships none — an override is the only way one exists at all.
    const book = bookOf([row({ provider: "openrouter", model: "some/model", inputPerMtok: 0.6 })])
    await book.refresh()

    expect(book.lookup("openrouter", "some/model")?.inputPerMtok).toBe(0.6)
  })

  test("a model neither table knows stays null, never zero", async () => {
    const book = bookOf([row()])
    await book.refresh()

    expect(book.lookup("openrouter", "some/model")).toBeNull()
    expect(book.lookup("anthropic-api", "claude-not-a-model")).toBeNull()
  })

  test("before the first load the book is exactly the shipped table", () => {
    const book = bookOf([row()])

    expect(book.lookup("anthropic-api", "claude-sonnet-5")?.inputPerMtok).toBe(3)
    expect(book.loadedAt()).toBeNull()
  })
})

describe("matching the model name", () => {
  test("a dated snapshot resolves to an override written on the family", async () => {
    const book = bookOf([row({ model: "claude-haiku-4-5", inputPerMtok: 7 })])
    await book.refresh()

    // An operator who priced the family meant it to cover the pin — the same rule the shipped
    // table follows, and the reason the normalization lives in one place.
    expect(book.lookup("anthropic-api", "claude-haiku-4-5-20251001")?.inputPerMtok).toBe(7)
    expect(book.lookup("anthropic-api", "  Claude-Haiku-4-5 ")?.inputPerMtok).toBe(7)
  })

  test("an override on the dated pin beats the family it belongs to", async () => {
    const book = bookOf([
      row({ model: "claude-haiku-4-5", inputPerMtok: 7 }),
      row({ id: "22222222-2222-2222-2222-222222222222", model: "claude-haiku-4-5-20251001" }),
    ])
    await book.refresh()

    expect(book.lookup("anthropic-api", "claude-haiku-4-5-20251001")?.inputPerMtok).toBe(1)
    expect(book.lookup("anthropic-api", "claude-haiku-4-5")?.inputPerMtok).toBe(7)
  })
})

describe("refreshing off the request path", () => {
  test("a failed refresh keeps the previous snapshot and reports the error", async () => {
    let attempt = 0
    const book = createPriceBook({
      load: async () => {
        attempt += 1
        if (attempt === 1) return [row()]
        throw new Error("connection reset")
      },
      refreshIntervalMs: 60_000,
      now: () => NOW,
    })

    await book.refresh()
    await expect(book.refresh()).rejects.toThrow("connection reset")

    // Reverting to the shipped numbers because one query timed out would show up as an
    // unexplained jump in a spend column, with nothing anywhere saying why.
    expect(book.lookup("anthropic-api", "claude-sonnet-5")?.inputPerMtok).toBe(1)
    expect(book.loadedAt()).toEqual(NOW)
  })

  test("concurrent refreshes share the one load in flight", async () => {
    let loads = 0
    const book = createPriceBook({
      load: async () => {
        loads += 1
        return [row()]
      },
      refreshIntervalMs: 60_000,
      now: () => NOW,
    })

    await Promise.all([book.refresh(), book.refresh(), book.refresh()])

    expect(loads).toBe(1)
  })

  test("the timer refreshes on its own, and stop() disarms it", async () => {
    let loads = 0
    let ticked = (): void => undefined
    const timerFired = new Promise<void>((resolve) => {
      ticked = resolve
    })
    const book = createPriceBook({
      load: async () => {
        loads += 1
        if (loads > 1) ticked()
        return [row()]
      },
      refreshIntervalMs: 5,
      now: () => NOW,
      jitter: () => 1,
    })

    await book.refresh()
    book.start()
    try {
      await Promise.race([
        timerFired,
        sleep(2_000).then(() => {
          throw new Error("the timer never fired")
        }),
      ])
    } finally {
      book.stop()
    }

    // Let anything already in flight settle, then hold still: a stopped book must not keep
    // querying, which is the difference between a shutdown and a leak.
    await sleep(10)
    const settled = loads
    await sleep(40)
    expect(loads).toBe(settled)
  })

  test("start() is idempotent and stop() is safe before it", () => {
    const book = bookOf([row()])

    book.stop()
    book.start()
    book.start()
    book.stop()
  })
})
