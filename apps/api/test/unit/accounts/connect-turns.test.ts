import { describe, expect, test } from "bun:test"
import { createAccountTurns } from "../../../src/services/accounts/connect/turns"

/**
 * The queue that makes "one Account has one pending login" true across awaits.
 *
 * Pure and clockless: what is asserted is the ordering guarantee `connect/claude.ts` leans on, and
 * that neither a failure nor a drained queue leaves anything behind.
 */

/** One macrotask, so every continuation already queued has run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("taking an account's turn", () => {
  test("holds the second turn until the first has settled", async () => {
    const turns = createAccountTurns()
    const gate = deferred()
    const order: string[] = []

    const first = turns.take("a", async () => {
      order.push("first in")
      await gate.promise
      order.push("first out")
    })
    const second = turns.take("a", async () => {
      order.push("second in")
    })
    await tick()

    // The whole point: the second body has not run at all, so it cannot read state the first is
    // still about to write.
    expect(order).toEqual(["first in"])

    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(["first in", "first out", "second in"])
  })

  test("two accounts run at once — a queue per account, never one queue", async () => {
    const turns = createAccountTurns()
    const gate = deferred()
    const running: string[] = []

    const a = turns.take("a", async () => {
      running.push("a")
      await gate.promise
    })
    const b = turns.take("b", async () => {
      running.push("b")
      await gate.promise
    })
    await tick()

    expect(running).toEqual(["a", "b"])
    gate.resolve()
    await Promise.all([a, b])
  })

  test("hands back the turn's own value", async () => {
    const turns = createAccountTurns()
    expect(await turns.take("a", async () => 7)).toBe(7)
  })

  test("a failed turn rejects its own caller and nothing else", async () => {
    const turns = createAccountTurns()

    const failed = turns.take("a", async () => {
      throw new Error("the CLI would not start")
    })
    const next = turns.take("a", async () => "ran anyway")

    await expect(failed).rejects.toThrow("the CLI would not start")
    expect(await next).toBe("ran anyway")
  })

  test("drops an account's queue once it drains, so the map cannot grow with account count", async () => {
    const turns = createAccountTurns()
    const gate = deferred()

    const held = turns.take("a", () => gate.promise)
    expect(turns.size).toBe(1)

    gate.resolve()
    await held
    await tick()
    expect(turns.size).toBe(0)
  })

  test("a queue that drained can be taken again", async () => {
    const turns = createAccountTurns()
    const order: string[] = []

    await turns.take("a", async () => {
      order.push("first")
    })
    await tick()
    await turns.take("a", async () => {
      order.push("second")
    })

    expect(order).toEqual(["first", "second"])
  })
})
