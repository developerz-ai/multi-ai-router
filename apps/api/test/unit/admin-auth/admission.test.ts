import { expect, test } from "bun:test"
import {
  AdminLoginThrottledError,
  createAdminAuthService,
} from "../../../src/services/admin-auth/service"

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
      config: { maxFailedAttempts: 2, maxConcurrentLogins: 2 },
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
