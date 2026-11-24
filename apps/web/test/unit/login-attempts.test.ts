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
