import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createRowRuns } from "../../src/lib/row-runs"

const within = (run: () => Promise<void>) => createRoot((dispose) => run().finally(dispose))

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
    expect(runs.data).toBe("done")
    a.reject(new Error("no"))
    await first
    expect(runs.pending().size).toBe(0)
    expect(runs.isError).toBe(true)
  }))

test("a row already running is not started twice, and reset clears what is shown", () =>
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
    expect(runs.isSuccess).toBe(true)
    runs.reset()
    expect(runs.data).toBeUndefined()
  }))
