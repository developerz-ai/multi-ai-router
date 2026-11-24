import { expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { createSilentHold } from "../../../src/services/dataplane/silent-hold"
import { peekSuccess } from "../../../src/services/dataplane/success-wall"

const CLOCKS = { firstByteMs: 1, idleMs: 55_000, totalMs: 1, wallHoldMs: 5_000 }

/** A clock the test moves: timers fire in order as time passes them. */
function manual() {
  let now = 0
  let timers: { at: number; fn: () => void }[] = []
  return {
    now: () => now,
    after(ms: number, fn: () => void) {
      const timer = { at: now + ms, fn }
      timers.push(timer)
      return () => {
        timers = timers.filter((entry) => entry !== timer)
      }
    },
    async advance(ms: number) {
      now += ms
      const due = timers.filter((entry) => entry.at <= now)
      timers = timers.filter((entry) => entry.at > now)
      for (const { fn } of due) fn()
      await Bun.sleep(0)
    },
  }
}

function silentPeek(
  silence: ReturnType<typeof createSilentHold>,
  clock: ReturnType<typeof manual>,
) {
  const driver = httpDriver("anthropic-api")
  if (driver === null || driver === undefined) throw new Error("no driver")
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c
    },
  })
  let settled = ""
  const peek = peekSuccess(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    { dialect: "anthropic", driver, maxBytes: 4096, hold: { ms: 5_000, clock, silence } },
  ).then(
    (result) => {
      settled = result.kind
    },
    () => {
      settled = "failed"
    },
  )
  return { peek, settled: () => settled, fail: () => controller?.error(new Error("idle")) }
}

test("untouched, the idle clock is the bound: no commit timer races it", async () => {
  const clock = manual()
  const silence = createSilentHold(CLOCKS)
  const first = silentPeek(silence, clock)
  await clock.advance(5_000)
  await clock.advance(50_000)
  expect(first.settled()).toBe("")
  first.fail()
  await first.peek
  expect(first.settled()).toBe("failed")
  expect(silence.remainingMs()).toBe(0)

  const second = silentPeek(silence, clock)
  await clock.advance(5_000)
  expect(second.settled()).toBe("clear")
})

test("a partial spend leaves the rest to the next silent account", async () => {
  const clock = manual()
  const silence = createSilentHold(CLOCKS)
  const first = silentPeek(silence, clock)
  await clock.advance(5_000)
  await clock.advance(20_000)
  first.fail()
  await first.peek
  expect(silence.remainingMs()).toBe(30_000)

  const second = silentPeek(silence, clock)
  await clock.advance(5_000)
  await clock.advance(29_999)
  expect(second.settled()).toBe("")
  await clock.advance(1)
  expect(second.settled()).toBe("clear")
})

test("an ordinary wait inside the wall hold spends nothing", async () => {
  const clock = manual()
  const silence = createSilentHold(CLOCKS)
  const peek = silentPeek(silence, clock)
  await clock.advance(4_999)
  peek.fail()
  await peek.peek
  expect(silence.remainingMs()).toBeUndefined()
})
