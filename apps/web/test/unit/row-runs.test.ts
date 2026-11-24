import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createRowRuns } from "../../src/lib/row-runs"

const within = (run: () => Promise<void>) => createRoot((dispose) => run().finally(dispose))
const fail = (message: string) => () => Promise.reject(new Error(message))
const message = (error: unknown) => (error instanceof Error ? error.message : undefined)

test("each row's run is its own: a second start hides neither the first's spinner nor its error", () =>
  within(async () => {
    const runs = createRowRuns<string>()
    const a = Promise.withResolvers<string>()
    const b = Promise.withResolvers<string>()
    const first = runs.run("a", () => a.promise)
    const second = runs.run("b", () => b.promise)
    expect([...runs.pending()]).toEqual(["a", "b"])
    b.resolve("done")
    await second
    expect([...runs.pending()]).toEqual(["a"])
    expect(runs.results().get("b")).toBe("done")
    a.reject(new Error("no"))
    await first
    expect(runs.pending().size).toBe(0)
    expect(message(runs.errors().get("a"))).toBe("no")
  }))

test("a failure stays until its own row runs again or is reset", () =>
  within(async () => {
    const runs = createRowRuns<string>()
    await runs.run("a", fail("first"))
    await runs.run("b", fail("second"))
    await runs.run("c", () => Promise.resolve("fine"))
    expect([...runs.errors().keys()]).toEqual(["a", "b"])
    await runs.run("a", () => Promise.resolve("fixed"))
    expect([...runs.errors().keys()]).toEqual(["b"])
    runs.reset("b")
    expect(runs.errors().size).toBe(0)
    runs.reset("a")
    expect([...runs.results().keys()]).toEqual(["c"])
  }))

test("a row already running is not started twice", () =>
  within(async () => {
    const runs = createRowRuns<number>()
    const gate = Promise.withResolvers<number>()
    let starts = 0
    const start = () => {
      starts += 1
      return gate.promise
    }
    const run = runs.run("a", start)
    await runs.run("a", start)
    expect(starts).toBe(1)
    gate.resolve(1)
    await run
  }))
