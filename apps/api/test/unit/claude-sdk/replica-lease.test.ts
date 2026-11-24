import { describe, expect, test } from "bun:test"
import type { AccountReplicaLeaseRepository } from "@multi-ai-router/db"
import { createReplicaLeaseManager } from "../../../src/providers/claude-sdk/replica-lease"

function fixture(safetyMarginMs = 0) {
  let time = 0
  let acquired: () => Promise<void> = async () => {}
  let renew: () => Promise<boolean> = async () => true
  let attach: () => Promise<void> = async () => {}
  let generation = 0n
  const calls: string[] = []
  const repository: AccountReplicaLeaseRepository = {
    async acquire(accountId, owner) {
      calls.push(`acquire:${accountId}`)
      await acquired()
      return {
        accountId,
        owner,
        generation: ++generation,
        expiresAt: new Date(),
        storageIdentity: null,
        state: "attaching",
      }
    },
    heartbeat: () => renew(),
    async ready() {
      calls.push("ready")
      return true
    },
    async drain() {
      calls.push("drain")
      return true
    },
    async release() {
      calls.push("release")
      return true
    },
  }
  const manager = createReplicaLeaseManager(
    repository,
    {
      identity: "fixture-volume",
      async attach() {
        calls.push("attach")
        await attach()
      },
    },
    { ttlMs: 1000, heartbeatMs: 100, batchSize: 2, safetyMarginMs },
    () => time,
  )
  return {
    manager,
    calls,
    acquisition: (fn: () => Promise<void>) => {
      acquired = fn
    },
    clock: (value: number) => {
      time = value
    },
    renewal: (fn: () => Promise<boolean>) => {
      renew = fn
    },
    attachment: (fn: () => Promise<void>) => {
      attach = fn
    },
  }
}
describe("replica-lease conservative local authority", () => {
  test("nonzero margin expires acquisition at equality, not database TTL", async () => {
    const f = fixture(200)
    const handle = await f.manager.ensure("a")
    expect(handle?.remainingMs()).toBe(800)
    f.clock(799)
    expect(handle?.valid()).toBe(true)
    f.clock(800)
    expect(handle?.valid()).toBe(false)
  })
  test("delayed acquisition at margin boundary never attaches", async () => {
    const f = fixture(200)
    let resolve = () => {}
    f.acquisition(
      () =>
        new Promise<void>((done) => {
          resolve = done
        }),
    )
    const acquisition = f.manager.ensure("a")
    f.clock(800)
    resolve()
    expect(await acquisition).toBeUndefined()
    expect(f.calls).toEqual(["acquire:a"])
  })
  test("renewal margin is measured before the database round trip", async () => {
    const f = fixture(200)
    const handle = await f.manager.ensure("a")
    let resolve = (_accepted: boolean) => {}
    f.renewal(
      () =>
        new Promise<boolean>((done) => {
          resolve = done
        }),
    )
    f.clock(400)
    const renewal = f.manager.renew()
    f.clock(700)
    resolve(true)
    await renewal
    expect(handle?.remainingMs()).toBe(500)
    f.clock(1199)
    expect(handle?.valid()).toBe(true)
    f.clock(1200)
    expect(handle?.valid()).toBe(false)
  })
  test("renewal arriving at the old margin boundary cannot resurrect authority", async () => {
    const f = fixture(200)
    const handle = await f.manager.ensure("a")
    let resolve = (_accepted: boolean) => {}
    f.renewal(
      () =>
        new Promise<boolean>((done) => {
          resolve = done
        }),
    )
    f.clock(400)
    const renewal = f.manager.renew()
    f.clock(800)
    resolve(true)
    await renewal
    expect(handle?.valid()).toBe(false)
    expect(handle?.signal.aborted).toBe(true)
    expect((await f.manager.ensure("a"))?.generation).toBe(2n)
  })
  test("attachment precedes readiness; deadline expiry invalidates retained handles", async () => {
    const f = fixture()
    const handle = await f.manager.ensure("a")
    expect(f.calls).toEqual(["acquire:a", "attach", "ready"])
    expect(handle?.valid()).toBe(true)
    f.clock(1000)
    expect(handle?.valid()).toBe(false)
    expect(handle?.signal.aborted).toBe(true)
  })
  test("delayed renewal cannot resurrect an expired generation", async () => {
    const f = fixture()
    const handle = await f.manager.ensure("a")
    let resolve: (value: boolean) => void = () => {}
    f.renewal(
      () =>
        new Promise<boolean>((done) => {
          resolve = done
        }),
    )
    f.clock(500)
    const renewal = f.manager.renew()
    f.clock(1001)
    resolve(true)
    await renewal
    expect(handle?.valid()).toBe(false)
    expect((await f.manager.ensure("a"))?.generation).toBe(2n)
  })
  test("a failed renewal keeps the earned deadline, and reaching it fails closed", async () => {
    const f = fixture(200)
    const handle = await f.manager.ensure("a")
    f.renewal(async () => {
      throw new Error("database unavailable")
    })
    for (const at of [100, 200, 799]) {
      f.clock(at)
      await f.manager.renew()
      expect(handle?.valid()).toBe(true)
      expect(handle?.signal.aborted).toBe(false)
    }
    // Never extended by the failures: the acquire-time margin still ends it.
    f.clock(800)
    await f.manager.renew()
    expect(handle?.valid()).toBe(false)
    expect(handle?.signal.aborted).toBe(true)
    expect(() => handle?.assert()).toThrow("account replica ownership unavailable")
  })
  test("a renewal that succeeds after a failed one extends the same generation", async () => {
    const f = fixture(200)
    const handle = await f.manager.ensure("a")
    f.renewal(async () => {
      throw new Error("connection reset")
    })
    f.clock(100)
    await f.manager.renew()
    f.renewal(async () => true)
    f.clock(200)
    await f.manager.renew()
    expect(handle?.remainingMs()).toBe(800)
    expect(f.calls).toEqual(["acquire:a", "attach", "ready"])
  })
  test("a refused renewal and a backward clock fail closed at once", async () => {
    for (const failure of ["refused", "clock"]) {
      const f = fixture()
      const handle = await f.manager.ensure("a")
      if (failure === "refused") {
        f.renewal(async () => false)
        await f.manager.renew()
      } else {
        f.clock(-1)
      }
      expect(handle?.valid()).toBe(false)
      expect(() => handle?.assert()).toThrow("account replica ownership unavailable")
    }
  })
  test("clock failure permanently closes acquisition even after the clock recovers", async () => {
    const f = fixture()
    await f.manager.ensure("a")
    f.clock(Number.NaN)
    expect(f.manager.eligible("a")).toBe(false)
    f.clock(1)
    expect(await f.manager.ensure("b")).toBeUndefined()
    expect(f.calls).not.toContain("acquire:b")
  })
  test("release follows confirmed quiescence; uncertainty never releases", async () => {
    for (const uncertain of [false, true]) {
      const f = fixture()
      const handle = await f.manager.ensure("a")
      const stopped = f.manager.stop(async () => {
        expect(f.manager.eligible("a")).toBe(false)
        f.calls.push("quiescent")
        if (uncertain) throw new Error("uncertain")
      })
      if (uncertain) await expect(stopped).rejects.toThrow("uncertain")
      else await stopped
      expect(f.calls.slice(3)).toEqual(
        uncertain ? ["quiescent"] : ["quiescent", "drain", "release"],
      )
      expect(handle?.signal.aborted).toBe(true)
    }
  })
  test("reconciliation is bounded and duplicate acquisitions single flight", async () => {
    const f = fixture()
    await f.manager.reconcile(["a", "b", "c"])
    await Promise.all([f.manager.ensure("a"), f.manager.ensure("a")])
    expect(f.calls.filter((call) => call.startsWith("acquire:"))).toEqual([
      "acquire:a",
      "acquire:b",
    ])
    await f.manager.reconcile(["a", "b", "c"])
    expect(f.manager.eligible("c")).toBe(true)
  })
  test("failed attachment retries with fresh authority instead of retaining a dead entry", async () => {
    const f = fixture()
    f.attachment(async () => {
      throw new Error("attachment unavailable")
    })
    expect(await f.manager.ensure("a")).toBeUndefined()
    f.attachment(async () => {})
    expect((await f.manager.ensure("a"))?.generation).toBe(2n)
    expect(f.calls).toEqual(["acquire:a", "attach", "acquire:a", "attach", "ready"])
  })
  test("stop during attachment never publishes readiness or releases before drain", async () => {
    const f = fixture()
    let attached = () => {}
    let entered = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.attachment(
      () =>
        new Promise<void>((resolve) => {
          attached = resolve
          entered()
        }),
    )
    const acquiring = f.manager.ensure("a")
    await started
    let drained = false
    const stopped = f.manager.stop(async () => {
      drained = true
    })
    expect(drained).toBe(false)
    attached()
    expect(await acquiring).toBeUndefined()
    await stopped
    expect(drained).toBe(true)
    expect(f.calls).not.toContain("ready")
  })
})

test("authority ends at the deadline even when nothing asks", async () => {
  // A heartbeat that throws or hangs used to leave the signal open until a later beat looked.
  for (const hangs of [false, true]) {
    const beat = Promise.withResolvers<boolean>()
    const heartbeat = () => (hangs ? beat.promise : Promise.reject(new Error("connection lost")))
    const manager = createReplicaLeaseManager(
      {
        acquire: async (accountId, owner) => ({
          accountId,
          owner,
          generation: 1n,
          expiresAt: new Date(),
          storageIdentity: null,
          state: "attaching",
        }),
        heartbeat,
        ready: async () => true,
        drain: async () => true,
        release: async () => true,
      },
      { identity: "volume", attach: async () => {} },
      { ttlMs: 300, heartbeatMs: 80, safetyMarginMs: 50, batchSize: 1 },
    )
    const started = performance.now()
    const handle = await manager.ensure("a")
    if (handle === undefined) throw new Error("not acquired")
    manager.start()
    const aborted = new Promise<number>((resolve) =>
      handle.signal.addEventListener("abort", () => resolve(performance.now() - started)),
    )
    try {
      const at = await Promise.race([aborted, Bun.sleep(1_000).then(() => Number.NaN)])
      expect(at).toBeGreaterThanOrEqual(245)
      // Before the row's own TTL, which is when another replica may take it.
      expect(at).toBeLessThan(300)
    } finally {
      // The beat still in flight is settled and the timer stopped, so nothing outlives the test.
      beat.resolve(false)
      await manager.stop(async () => {})
    }
  }
})

test("a renewal moves the deadline the signal ends at", async () => {
  const manager = createReplicaLeaseManager(
    {
      acquire: async (accountId, owner) => ({
        accountId,
        owner,
        generation: 1n,
        expiresAt: new Date(),
        storageIdentity: null,
        state: "attaching",
      }),
      heartbeat: async () => true,
      ready: async () => true,
      drain: async () => true,
      release: async () => true,
    },
    { identity: "volume", attach: async () => {} },
    { ttlMs: 200, heartbeatMs: 40, safetyMarginMs: 20, batchSize: 1 },
  )
  const handle = await manager.ensure("a")
  manager.start()
  try {
    await Bun.sleep(500)
    expect(handle?.signal.aborted).toBe(false)
  } finally {
    await manager.stop(async () => {})
  }
  expect(handle?.signal.aborted).toBe(true)
})
