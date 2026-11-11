import { expect, test } from "bun:test"
import type { AdminOidcConfig } from "../../../src/config/env-admin-types"
import type { AuditEventInput, AuditRecorder } from "../../../src/services/admin/audit"
import type { LocalAdminCredentials } from "../../../src/services/admin-auth/localCredential"
import {
  AdminLoginThrottledError,
  createAdminAuthService,
  LOCAL_ADMIN_USERNAME,
} from "../../../src/services/admin-auth/service"
import { createMemorySessionStore } from "../../../src/services/admin-auth/sessionStore"

const encryptionKey = Buffer.alloc(32, 7).toString("base64")

function auditSink(): { recorder: AuditRecorder; events: AuditEventInput[] } {
  const events: AuditEventInput[] = []
  return {
    events,
    recorder: {
      record: async (event) => {
        events.push(event)
      },
    },
  }
}

function local(state: { configured: boolean; reads: number }): LocalAdminCredentials {
  return {
    isConfigured: async () => {
      state.reads++
      return state.configured
    },
    verify: async (password) => password === "correct horse battery staple",
    set: async () => {},
    remove: async () => false,
  }
}

function oidcEnv(adminEmails: readonly string[] | null): AdminOidcConfig {
  return {
    issuerUrl: "https://idp.test",
    clientId: "router",
    clientSecret: null,
    redirectUri: "https://router.test/api/admin/auth/oidc/callback",
    adminEmails,
    requiredClaims: [],
    adminSubject: null,
    scopes: ["openid", "email"],
    clockSkewSeconds: 60,
    requestTimeoutMs: 1_000,
  }
}

function oidcFlow(email: string, failures: { calls: number; fail: boolean }) {
  return {
    start: async () => ({ authorizeUrl: "https://idp.test/authorize", state: "s" }),
    complete: async () => {
      failures.calls++
      if (failures.fail) throw new Error("bogus callback")
      return { email, subject: "sub" }
    },
  }
}

test("a thousand throttled password attempts write one audit row, not a thousand", async () => {
  const { recorder, events } = auditSink()
  const service = createAdminAuthService({
    env: { adminOidc: null, encryptionKey },
    local: local({ configured: true, reads: 0 }),
    config: { maxFailedAttempts: 2 },
    audit: recorder,
  })
  for (let i = 0; i < 1002; i++) {
    await service.completeLocalLogin({ password: "wrong", ip: "198.51.100.1" }).catch(() => {})
  }
  const throttled = events.filter(
    (e) => (e.detail as { reason?: string } | undefined)?.reason === "throttled",
  )
  expect(throttled).toHaveLength(1)
})

test("bogus OIDC callbacks are throttled per IP before the state is consumed", async () => {
  const { recorder, events } = auditSink()
  const counter = { calls: 0, fail: true }
  const service = createAdminAuthService({
    env: { adminOidc: oidcEnv(["admin@test"]), encryptionKey },
    oidc: oidcFlow("admin@test", counter),
    config: { maxFailedAttempts: 5 },
    audit: recorder,
  })
  const outcomes: unknown[] = []
  for (let i = 0; i < 50; i++) {
    outcomes.push(
      await service
        .completeLogin({ code: "a", state: "b", ip: "198.51.100.2" })
        .catch((error: unknown) => error),
    )
  }
  expect(counter.calls).toBe(5)
  expect(outcomes.filter((o) => o instanceof AdminLoginThrottledError)).toHaveLength(45)
  // Five rejections plus one lockout transition — bounded however long the loop runs.
  expect(events).toHaveLength(6)
})

test("a completed OIDC sign-in resets the start and callback buckets", async () => {
  const counter = { calls: 0, fail: false }
  const service = createAdminAuthService({
    env: { adminOidc: oidcEnv(["admin@test"]), encryptionKey },
    oidc: oidcFlow("admin@test", counter),
    config: { maxFailedAttempts: 3 },
  })
  for (let round = 0; round < 5; round++) {
    await service.startLogin("198.51.100.3")
    await service.startLogin("198.51.100.3")
    await service.completeLogin({ code: "c", state: "s", ip: "198.51.100.3" })
  }
  expect(counter.calls).toBe(5)
})

test("a session whose email left ADMIN_OIDC_ADMIN_EMAIL is refused and deleted", async () => {
  const store = createMemorySessionStore()
  const counter = { calls: 0, fail: false }
  const before = createAdminAuthService({
    env: { adminOidc: oidcEnv(["admin@test", "gone@test"]), encryptionKey },
    oidc: oidcFlow("Gone@Test", counter),
    store,
  })
  const login = await before.completeLogin({ code: "c", state: "s", ip: "198.51.100.4" })
  expect(login.session.username).toBe("gone@test")
  expect((await before.authenticate(login.cookieValue)).username).toBe("gone@test")

  // The redeploy: same store, same signing key, the allowlist without that operator.
  const after = createAdminAuthService({
    env: { adminOidc: oidcEnv(["admin@test"]), encryptionKey },
    oidc: oidcFlow("admin@test", counter),
    store,
  })
  await expect(after.authenticate(login.cookieValue)).rejects.toThrow()
  expect(await store.get(login.session.id)).toBeUndefined()
})

test("an email session is refused once OIDC is unconfigured; claims-only gates keep it", async () => {
  const store = createMemorySessionStore()
  const counter = { calls: 0, fail: false }
  const issuer = createAdminAuthService({
    env: { adminOidc: oidcEnv(null), encryptionKey },
    oidc: oidcFlow("dev@test", counter),
    store,
  })
  const login = await issuer.completeLogin({ code: "c", state: "s", ip: "198.51.100.5" })
  expect((await issuer.authenticate(login.cookieValue)).username).toBe("dev@test")

  const noOidc = createAdminAuthService({ env: { adminOidc: null, encryptionKey }, store })
  await expect(noOidc.authenticate(login.cookieValue)).rejects.toThrow()
})

test("a password session ends once the password is removed, within the credential TTL", async () => {
  let now = 0
  const state = { configured: true, reads: 0 }
  const service = createAdminAuthService({
    env: { adminOidc: null, encryptionKey },
    local: local(state),
    localCredentialTtlMs: 1_000,
    now: () => now,
  })
  const login = await service.completeLocalLogin({
    password: "correct horse battery staple",
    ip: "198.51.100.6",
  })
  expect(login.session.username).toBe(LOCAL_ADMIN_USERNAME)
  expect((await service.authenticate(login.cookieValue)).username).toBe(LOCAL_ADMIN_USERNAME)

  state.configured = false
  now = 1_000
  await expect(service.authenticate(login.cookieValue)).rejects.toThrow()
})

test("methods and session checks read the credential row once per TTL, not per request", async () => {
  let now = 0
  const state = { configured: true, reads: 0 }
  const service = createAdminAuthService({
    env: { adminOidc: null, encryptionKey },
    local: local(state),
    localCredentialTtlMs: 60_000,
    now: () => now,
  })
  await Promise.all(Array.from({ length: 100 }, () => service.methods()))
  expect(state.reads).toBe(1)
  now = 60_000
  expect((await service.methods()).local).toBe(true)
  expect(state.reads).toBe(2)
})
