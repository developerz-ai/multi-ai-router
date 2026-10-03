import { expect, test } from "bun:test"
import { resolveAdminAuthConfig } from "../../../src/services/admin-auth/config"
import {
  AdminLoginThrottledError,
  createAdminAuthService,
} from "../../../src/services/admin-auth/service"
import { createLoginThrottle } from "../../../src/services/admin-auth/throttle"

const env = { adminOidc: null, encryptionKey: Buffer.alloc(32, 7).toString("base64") }

for (const uniqueIps of [false, true]) {
  test(`password work has bounded admission (unique IPs=${uniqueIps})`, async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let verifies = 0
    const service = createAdminAuthService({
      env,
      config: { maxFailedAttempts: 2, maxConcurrentLogins: uniqueIps ? 2 : 4 },
      local: {
        isConfigured: async () => true,
        set: async () => {},
        remove: async () => false,
        verify: async () => {
          verifies++
          await gate
          return false
        },
      },
    })
    const pending = Array.from({ length: 20 }, (_, i) =>
      service
        .completeLocalLogin({ password: "wrong", ip: uniqueIps ? `ip-${i}` : "ip" })
        .catch((error: unknown) => error),
    )
    expect(verifies).toBe(2)
    release()
    const outcomes = await Promise.all(pending)
    expect(outcomes.filter((error) => error instanceof AdminLoginThrottledError)).toHaveLength(18)
  })
}

test("a successful login reset cannot bypass the global password work limit", async () => {
  const completions: ((verified: boolean) => void)[] = []
  const service = createAdminAuthService({
    env,
    config: { maxFailedAttempts: 2, maxConcurrentLogins: 2 },
    local: {
      isConfigured: async () => true,
      set: async () => {},
      remove: async () => false,
      verify: () => new Promise<boolean>((resolve) => completions.push(resolve)),
    },
  })
  const login = () =>
    service.completeLocalLogin({ password: "password", ip: "ip" }).catch((error: unknown) => error)
  const successful = login()
  const stillRunning = login()
  expect(completions).toHaveLength(2)
  completions[0]?.(true)
  await successful
  const afterReset = login()
  expect(completions).toHaveLength(3)
  expect(await login()).toBeInstanceOf(AdminLoginThrottledError)
  expect(completions).toHaveLength(3)
  completions[1]?.(false)
  completions[2]?.(false)
  await Promise.all([stillRunning, afterReset])
})

test("an IP spray cannot evict unlocked attempts to avoid the failure threshold", () => {
  const throttle = createLoginThrottle(
    resolveAdminAuthConfig({ maxTrackedIps: 2, maxFailedAttempts: 2, attemptWindowSeconds: 10 }),
  )
  for (const ip of ["a", "b"]) {
    expect(throttle.check([ip], 0).allowed).toBe(true)
    throttle.recordFailure([ip], 0)
  }
  for (let index = 0; index < 20; index++) {
    expect(throttle.check([`spray-${index}`], 1).allowed).toBe(false)
  }
  expect(throttle.check(["a"], 1).allowed).toBe(true)
  throttle.recordFailure(["a"], 1)
  expect(throttle.check(["a"], 1).allowed).toBe(false)
  expect(throttle.check(["new"], 10_000).allowed).toBe(true)
})

test("OIDC starts consume the per-IP admission budget before state is issued", async () => {
  let calls = 0
  const service = createAdminAuthService({
    env,
    config: { maxFailedAttempts: 2 },
    oidc: {
      start: async () => {
        calls++
        return { authorizeUrl: "https://idp.test", state: "test" }
      },
      complete: async () => ({ email: "admin@test", subject: "test" }),
    },
  })
  await service.startLogin("ip")
  await service.startLogin("ip")
  await expect(service.startLogin("ip")).rejects.toBeInstanceOf(AdminLoginThrottledError)
  expect(calls).toBe(2)
  await service.startLogin("other-ip")
  expect(calls).toBe(3)
})

test("password verifier exceptions release the global admission slot", async () => {
  let checks = 0
  const service = createAdminAuthService({
    env,
    config: { maxConcurrentLogins: 1 },
    local: {
      isConfigured: async () => true,
      set: async () => {},
      remove: async () => false,
      verify: async () => {
        checks++
        throw new Error("verification unavailable")
      },
    },
  })
  await expect(service.completeLocalLogin({ password: "wrong", ip: "a" })).rejects.toThrow(
    "verification unavailable",
  )
  await expect(service.completeLocalLogin({ password: "wrong", ip: "b" })).rejects.toThrow(
    "verification unavailable",
  )
  expect(checks).toBe(2)
})

test("a saturated IP table refuses new buckets and recovers after expiry", async () => {
  let now = 0
  let calls = 0
  const service = createAdminAuthService({
    env,
    now: () => now,
    config: { maxTrackedIps: 1, maxFailedAttempts: 1, lockoutSeconds: 1 },
    oidc: {
      start: async () => {
        calls++
        return { authorizeUrl: "https://idp.test", state: "test" }
      },
      complete: async () => ({ email: "admin@test", subject: "test" }),
    },
  })
  await service.startLogin("a")
  await expect(service.startLogin("b")).rejects.toBeInstanceOf(AdminLoginThrottledError)
  expect(calls).toBe(1)
  now = 1000
  await service.startLogin("b")
  expect(calls).toBe(2)
})
