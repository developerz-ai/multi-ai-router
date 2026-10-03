import { describe, expect, test } from "bun:test"
import postgres from "postgres"
import { advisoryLockKey } from "../../src/advisory-lock"
import { createSchedulerLockPool } from "../../src/scheduler-lock"
import { stalledProxy } from "./advisory-stall-fixture"

const url = process.env.DATABASE_URL ?? ""
describe.skipIf(!url)("scheduler auxiliary session failures", () => {
  for (const sql of ["pg_try_advisory_lock", "pg_advisory_unlock"] as const) {
    test(`${sql} stall retires the session and cannot leak its exclusion`, async () => {
      const proxy = await stalledProxy(url, sql)
      const lock = createSchedulerLockPool({
        url: proxy.url,
        connectTimeoutSeconds: 0.25,
        closeTimeoutSeconds: 0.1,
      })
      const key = advisoryLockKey(crypto.randomUUID())
      let worked = false
      try {
        const running = lock.tryRun(key, new AbortController().signal, async () => {
          worked = true
          return "done"
        })
        await proxy.stalled
        const result = await running
        expect(worked).toBe(sql === "pg_advisory_unlock")
        expect(result.acquired).toBe(sql === "pg_advisory_unlock")
        let next = await lock.tryRun(key, new AbortController().signal, async () => "next")
        for (let retry = 0; !next.acquired && retry < 100; retry++) {
          await Bun.sleep(10)
          next = await lock.tryRun(key, new AbortController().signal, async () => "next")
        }
        expect(next).toEqual({ acquired: true, value: "next" })
        expect(proxy.connections()).toBeGreaterThanOrEqual(2)
      } finally {
        await lock.close()
        await proxy.close()
      }
    })
  }
  for (const packet of ["__startup__", "pg_try_advisory_lock"] as const) {
    test(`close bounds ${packet} stall without running late task`, async () => {
      const proxy = await stalledProxy(url, packet)
      const lock = createSchedulerLockPool({
        url: proxy.url,
        connectTimeoutSeconds: 2,
        closeTimeoutSeconds: 0.03,
      })
      let worked = false
      const running = lock.tryRun(
        advisoryLockKey(crypto.randomUUID()),
        new AbortController().signal,
        async () => {
          worked = true
        },
      )
      try {
        await proxy.stalled
        const at = Date.now()
        await lock.close()
        expect(Date.now() - at).toBeLessThan(500)
        expect(await running).toEqual({ acquired: false, reason: "aborted" })
        proxy.resume()
        expect(worked).toBe(false)
        expect(await lock.tryRun(1, new AbortController().signal, async () => "late")).toEqual({
          acquired: false,
          reason: "aborted",
        })
      } finally {
        await lock.close()
        await proxy.close()
      }
    })
  }
  test("known scheduler backend loss aborts exclusion and permits a fresh session", async () => {
    const lock = createSchedulerLockPool({ url, closeTimeoutSeconds: 0.1 })
    const observer = postgres(url, { max: 1 })
    const key = advisoryLockKey(crypto.randomUUID())
    const entered = Promise.withResolvers<void>()
    const running = lock.tryRun(key, new AbortController().signal, async (signal) => {
      entered.resolve()
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      )
      return signal.aborted
    })
    try {
      await entered.promise
      const rows =
        await observer`select pid from pg_locks where locktype='advisory' and classid=${0x726f7574}::oid and objid=${key >>> 0}::oid`
      const pid = rows[0]?.pid
      if (typeof pid !== "number") throw new Error("scratch scheduler backend missing")
      expect((await observer`select pg_terminate_backend(${pid}) as killed`)[0]?.killed).toBe(true)
      expect(await running).toEqual({ acquired: true, value: true })
      let next = await lock.tryRun(key, new AbortController().signal, async () => "next")
      for (let retry = 0; !next.acquired && retry < 100; retry++) {
        await Bun.sleep(10)
        next = await lock.tryRun(key, new AbortController().signal, async () => "next")
      }
      expect(next).toEqual({ acquired: true, value: "next" })
    } finally {
      await observer.end({ timeout: 0 })
      await lock.close()
    }
  })
})
