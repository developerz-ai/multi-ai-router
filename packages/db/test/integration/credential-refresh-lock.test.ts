import { afterAll, describe, expect, test } from "bun:test"
import postgres from "postgres"
import { createDatabase } from "../../src/client"
import {
  type CredentialRefreshLockPoolHandle,
  createCredentialRefreshLockPool,
} from "../../src/credential-refresh-lock"

import { stalledProxy } from "./advisory-stall-fixture"

const url = process.env.DATABASE_URL ?? ""
const handles: CredentialRefreshLockPoolHandle[] = []
function pool(maxConnections = 1) {
  const handle = createCredentialRefreshLockPool({
    url,
    maxConnections,
    connectTimeoutSeconds: 2,
    closeTimeoutSeconds: 1,
  })
  handles.push(handle)
  return handle
}
afterAll(async () => {
  await Promise.all(handles.map((handle) => handle.close()))
})
function deferred<T>() {
  return Promise.withResolvers<T>()
}

describe.skipIf(!url)("dedicated credential refresh advisory sessions", () => {
  test("canceled delayed reserve releases its late session without running work", async () => {
    const proxy = await stalledProxy(url, "__startup__") // Own startup packet is deliberately withheld.
    const lock = createCredentialRefreshLockPool({
      url: proxy.url,
      connectTimeoutSeconds: 2,
      closeTimeoutSeconds: 0.25,
    })
    handles.push(lock)
    const controller = new AbortController()
    let worked = false
    try {
      const operation = lock.tryRun(crypto.randomUUID(), controller.signal, async () => {
        worked = true
      })
      await proxy.stalled
      controller.abort()
      expect(await operation).toEqual({ acquired: false, reason: "aborted" })
      expect(lock.poolStats().inUse).toBe(1)
      proxy.resume()
      for (let retry = 0; lock.poolStats().inUse !== 0 && retry < 100; retry++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
      expect(lock.poolStats().inUse).toBe(0)
      expect(worked).toBe(false)
      expect(
        await lock.tryRun(crypto.randomUUID(), new AbortController().signal, async () => "next"),
      ).toEqual({ acquired: true, value: "next" })
    } finally {
      await lock.close()
      await proxy.close()
    }
  })

  for (const sql of ["pg_try_advisory_lock", "pg_advisory_unlock"] as const) {
    test(`${sql} stalled response retires session before reuse`, async () => {
      const proxy = await stalledProxy(url, sql)
      const lock = createCredentialRefreshLockPool({
        url: proxy.url,
        connectTimeoutSeconds: 0.25,
        closeTimeoutSeconds: 0.25,
      })
      handles.push(lock)
      let worked = false
      try {
        const operation = lock.tryRun(
          crypto.randomUUID(),
          new AbortController().signal,
          async () => {
            worked = true
            return "saved"
          },
        )
        await proxy.stalled
        const result = await operation
        if (sql === "pg_try_advisory_lock") {
          expect(result).toEqual({ acquired: false, reason: "aborted" })
          expect(worked).toBe(false)
        } else {
          expect(result).toEqual({ acquired: true, value: "saved" })
          expect(worked).toBe(true)
        }
        // Retirement may still be disposing; busy is safe, and never uses the lost connection.
        let next = await lock.tryRun(
          crypto.randomUUID(),
          new AbortController().signal,
          async () => "next",
        )
        for (let retry = 0; !next.acquired && retry < 100; retry++) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
          next = await lock.tryRun(
            crypto.randomUUID(),
            new AbortController().signal,
            async () => "next",
          )
        }
        expect(next).toEqual({ acquired: true, value: "next" })
        expect(proxy.connections()).toBeGreaterThanOrEqual(2)
      } finally {
        await lock.close()
        await proxy.close()
      }
    })
  }

  test("separate instances serialize same account and main max1 stays available", async () => {
    const a = pool()
    const b = pool()
    const main = createDatabase({ url, maxConnections: 1 })
    const entered = deferred<void>()
    const finish = deferred<void>()
    const accountId = crypto.randomUUID()
    const first = a.tryRun(accountId, new AbortController().signal, async () => {
      entered.resolve()
      await finish.promise
      return "first"
    })
    try {
      await entered.promise
      expect((await main.sql`select 42 as answer`)[0]?.answer).toBe(42)
      expect(
        await a.tryRun(crypto.randomUUID(), new AbortController().signal, async () => "unexpected"),
      ).toEqual({ acquired: false, reason: "busy" })
      expect(
        await b.tryRun(accountId, new AbortController().signal, async () => "unexpected"),
      ).toEqual({ acquired: false, reason: "busy" })
    } finally {
      finish.resolve()
      await main.close()
    }
    expect(await first).toEqual({ acquired: true, value: "first" })
    expect(await b.tryRun(accountId, new AbortController().signal, async () => "next")).toEqual({
      acquired: true,
      value: "next",
    })
  })
  test("shutdown aborts mandatory work signal and refuses later admission", async () => {
    const lock = pool()
    const entered = deferred<void>()
    const first = lock.tryRun(crypto.randomUUID(), new AbortController().signal, async (signal) => {
      entered.resolve()
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      )
      return signal.aborted
    })
    await entered.promise
    await lock.close()
    expect(await first).toEqual({ acquired: true, value: true })
    expect(
      await lock.tryRun(crypto.randomUUID(), new AbortController().signal, async () => false),
    ).toEqual({ acquired: false, reason: "aborted" })
    expect(lock.poolStats().inUse).toBe(0)
  })
  test("pre-aborted caller never reserves or executes", async () => {
    const lock = pool()
    const controller = new AbortController()
    controller.abort()
    let ran = false
    expect(
      await lock.tryRun(crypto.randomUUID(), controller.signal, async () => {
        ran = true
      }),
    ).toEqual({ acquired: false, reason: "aborted" })
    expect(ran).toBe(false)
    expect(lock.poolStats().inUse).toBe(0)
  })
  test("killing the known lock backend aborts all holders conservatively", async () => {
    const lock = pool(2)
    const observer = postgres(url, { max: 1 })
    const entered = deferred<void>()
    const accountId = crypto.randomUUID()
    const first = lock.tryRun(accountId, new AbortController().signal, async (signal) => {
      entered.resolve()
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      )
      return signal.aborted
    })
    const otherEntered = deferred<void>()
    const other = lock.tryRun(crypto.randomUUID(), new AbortController().signal, async (signal) => {
      otherEntered.resolve()
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      )
      return signal.aborted
    })
    try {
      await Promise.all([entered.promise, otherEntered.promise])
      // Namespace is private to this implementation; PID is fetched only from this scratch lock.
      // account hash narrows further so concurrently running fixtures cannot be killed.
      let hash = 0x811c9dc5
      for (const char of accountId) {
        hash ^= char.charCodeAt(0)
        hash = Math.imul(hash, 0x01000193)
      }
      const rows =
        await observer`select pid from pg_locks where locktype='advisory' and classid=${0x72656672}::oid and objid=${hash >>> 0}::oid`
      const pid = rows[0]?.pid
      if (typeof pid !== "number") throw new Error("scratch lock backend missing")
      expect((await observer`select pg_terminate_backend(${pid}) as killed`)[0]?.killed).toBe(true)
      expect(await first).toEqual({ acquired: true, value: true })
      expect(await other).toEqual({ acquired: true, value: true })
    } finally {
      await observer.end({ timeout: 0 })
      await lock.close()
    }
  })
})
