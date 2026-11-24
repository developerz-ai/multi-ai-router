import { expect, test } from "bun:test"
import { createLoginAttempts } from "../../src/routes/accounts/login-attempts"

function attempts() {
  const cancelled: string[] = []
  return { cancelled, log: createLoginAttempts((id) => cancelled.push(id)) }
}

test("a start nobody waits for is cancelled when it lands", () => {
  const { cancelled, log } = attempts()
  const one = log.begin("a")
  log.orphaned("a", one)
  expect(cancelled).toEqual(["a"])
})

test("one a newer start replaced is left alone: cancelling it would kill the newer", () => {
  const { cancelled, log } = attempts()
  const one = log.begin("a")
  const two = log.begin("a")
  log.orphaned("a", one)
  expect(cancelled).toEqual([])
  log.shown("a", two)
  expect(cancelled).toEqual([])
})

test("it is cancelled after all when the start that replaced it fails, in either order", () => {
  const late = attempts()
  const first = late.log.begin("a")
  late.log.failed("a", late.log.begin("a"))
  late.log.orphaned("a", first)
  expect(late.cancelled).toEqual(["a"])

  const early = attempts()
  const slow = early.log.begin("a")
  const next = early.log.begin("a")
  early.log.orphaned("a", slow)
  early.log.failed("a", next)
  expect(early.cancelled).toEqual(["a"])
})

test("a replaced start that lands late is left alone, and accounts never mix", () => {
  const { cancelled, log } = attempts()
  const one = log.begin("a")
  const two = log.begin("a")
  log.shown("a", two)
  log.orphaned("a", one)
  expect(cancelled).toEqual([])
  const other = log.begin("b")
  log.begin("a")
  log.orphaned("b", other)
  expect(cancelled).toEqual(["b"])
})

test("an older start still in flight is cancelled too, after the newer one was", () => {
  const { cancelled, log } = attempts()
  const slow = log.begin("a")
  const quick = log.begin("a")
  log.orphaned("a", quick)
  expect(cancelled).toEqual(["a"])
  log.orphaned("a", slow)
  expect(cancelled).toEqual(["a", "a"])
})

test("one that lands after the newer was left, or finished, is cancelled; before, it is covered", () => {
  for (const end of ["orphaned", "finished"] as const) {
    const { cancelled, log } = attempts()
    const slow = log.begin("a")
    const quick = log.begin("a")
    log.shown("a", quick)
    log[end]("a", quick)
    cancelled.length = 0
    log.orphaned("a", slow)
    expect(cancelled).toEqual(["a"])
  }
  const { cancelled, log } = attempts()
  const slow = log.begin("a")
  const quick = log.begin("a")
  log.shown("a", quick)
  log.orphaned("a", slow)
  log.orphaned("a", quick)
  expect(cancelled).toEqual(["a"])
})

test("one that landed before the newer one's success was heard is cancelled with it", () => {
  const { cancelled, log } = attempts()
  const slow = log.begin("a")
  const quick = log.begin("a")
  log.shown("a", quick)
  // The router may have finished `quick` already, and held `slow` since.
  log.orphaned("a", slow)
  expect(cancelled).toEqual([])
  log.finished("a", quick)
  expect(cancelled).toEqual(["a"])
})

test("finishing never cancels a newer start, nor anything when nothing was abandoned", () => {
  const { cancelled, log } = attempts()
  const slow = log.begin("a")
  const quick = log.begin("a")
  log.shown("a", quick)
  log.orphaned("a", slow)
  const next = log.begin("a")
  log.finished("a", quick)
  expect(cancelled).toEqual([])
  log.failed("a", next)
  expect(cancelled).toEqual(["a"])

  const only = log.begin("b")
  log.shown("b", only)
  log.finished("b", only)
  expect(cancelled).toEqual(["a"])
})
