import { Hono } from "hono"
import { createLogger } from "../../src/logging/logger"
import { errorHandler } from "../../src/middleware/errorHandler"
import { adminAuthRoutes } from "../../src/routes/admin/auth"
import { createAdminAuthService } from "../../src/services/admin-auth/service"
import type { AdminServices, AppEnv } from "../../src/types"

export const unexpected = (): never => {
  throw new Error("unexpected fixture operation")
}
export function authService() {
  return createAdminAuthService({
    env: { adminOidc: null, encryptionKey: Buffer.alloc(32, 7).toString("base64") },
  })
}
export function adminFixture(auth: AdminServices["auth"]): AdminServices {
  return {
    auth,
    accounts: {
      list: unexpected,
      get: unexpected,
      create: unexpected,
      update: unexpected,
      disable: unexpected,
      remove: unexpected,
    },
    pools: {
      list: unexpected,
      get: unexpected,
      create: unexpected,
      update: unexpected,
      remove: unexpected,
    },
    keys: {
      list: unexpected,
      get: unexpected,
      create: unexpected,
      update: unexpected,
      reveal: unexpected,
      revoke: unexpected,
      remove: unexpected,
    },
    usage: { summary: unexpected, recent: unexpected },
    settings: { read: unexpected, update: unexpected, tasks: unexpected, audit: unexpected },
    recheck: { recheck: unexpected, recheckAll: unexpected },
    testNow: { test: unexpected, lastCheckedAt: unexpected },
    discoverModels: { discover: unexpected },
    connect: {
      begin: unexpected,
      complete: unexpected,
      cancel: unexpected,
      redeem: unexpected,
      closeAdmission: unexpected,
      revoke: unexpected,
      stop: unexpected,
    },
  }
}
export const probes = {
  database: async () => true,
  accounts: async () => "none" as const,
  claudeCli: async () => "missing" as const,
  shuttingDown: () => false,
}
export const headerCases: Record<string, string>[] = [{ "content-length": "100" }, {}]
export const logger = createLogger({ level: "error", write() {} })
export function login() {
  let calls = 0
  const app = new Hono<AppEnv>().onError(errorHandler(logger))
  app.route(
    "/api/admin/auth",
    adminAuthRoutes({
      trustProxy: false,
      sessionCookieInsecure: false,
      maximumJsonBytes: 32,
      service: {
        ...authService(),
        completeLocalLogin: async () => {
          calls++
          throw new Error("fixture wrong credential")
        },
      },
    }),
  )
  return { app, calls: () => calls }
}
export function baseEnv() {
  return {
    DATABASE_URL: "postgres://fixture:fixture@localhost/fixture",
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ADMIN_OIDC_ISSUER_URL: "https://idp.fixture",
    ADMIN_OIDC_CLIENT_ID: "fixture",
    ADMIN_OIDC_REDIRECT_URI: "https://router.fixture/api/admin/auth/oidc/callback",
    ADMIN_OIDC_ADMIN_EMAIL: "admin@fixture",
  }
}
export const request = (
  body: string | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
) =>
  new Request("http://fixture/api/admin/auth/login", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit)
