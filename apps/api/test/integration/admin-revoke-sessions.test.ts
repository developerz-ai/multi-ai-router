import { afterAll, beforeAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import {
  type AdminSessionRepository,
  createAdminSessionRepository,
  createDatabase,
  type DatabaseHandle,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import type { AdminOidcConfig } from "../../src/config/env-admin-types"
import { createLogger } from "../../src/logging/logger"
import {
  createPostgresSessionStore,
  hashSessionId,
} from "../../src/services/admin-auth/postgresSessionStore"
import { createAdminAuthService } from "../../src/services/admin-auth/service"

/**
 * `bin/admin revoke-sessions --user` against the real table: the sessions it names stop
 * authenticating, every other row survives. Scoped to two throwaway emails so it never touches a
 * session another test in the shared database owns — which is also why the unscoped form and the
 * password verbs (they sign out every `local-admin` session) are not run here.
 */
const databaseUrl = process.env.DATABASE_URL
const runnable = databaseUrl !== undefined && databaseUrl !== ""
const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64")
const SCRIPT = resolve(import.meta.dir, "../../src/bin/admin.ts")
const run = randomUUID().slice(0, 8)
const REVOKED = `revoked-${run}@test`
const KEPT = `kept-${run}@test`

let handle: DatabaseHandle | undefined
let repository: AdminSessionRepository
const issued: string[] = []
/** The email the stub IdP asserts on the next callback. */
let currentEmail = REVOKED

beforeAll(async () => {
  if (!runnable) return
  await runMigrations({ url: databaseUrl ?? "", migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url: databaseUrl ?? "", maxConnections: 2 })
  repository = createAdminSessionRepository(handle.db)
})

afterAll(async () => {
  if (handle !== undefined) {
    for (const id of issued) await repository.delete(hashSessionId(id))
  }
  await handle?.close()
})

function oidcConfig(adminEmails: readonly string[]): AdminOidcConfig {
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

function service() {
  return createAdminAuthService({
    env: {
      adminOidc: oidcConfig([REVOKED, KEPT]),
      encryptionKey: ENCRYPTION_KEY,
    },
    oidc: {
      start: async () => ({ authorizeUrl: "https://idp.test", state: "s" }),
      complete: async () => ({ email: currentEmail, subject: "sub" }),
    },
    store: createPostgresSessionStore({
      repository,
      logger: createLogger({ level: "error", write: () => undefined }),
      cacheMaxEntries: 16,
      revalidateAfterMs: 0,
    }),
  })
}
async function admin(...args: string[]): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(["bun", SCRIPT, ...args], {
    env: { ...process.env, DATABASE_URL: databaseUrl ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(child.stdout).text()
  return { code: await child.exited, stdout }
}

test.skipIf(!runnable)(
  "revoke-sessions --user signs that operator out and no one else",
  async () => {
    const auth = service()
    currentEmail = REVOKED
    const revoked = await auth.completeLogin({ code: "c", state: "s", ip: "203.0.113.1" })
    currentEmail = KEPT
    const kept = await auth.completeLogin({ code: "c", state: "s", ip: "203.0.113.1" })
    issued.push(revoked.session.id, kept.session.id)
    expect((await auth.authenticate(revoked.cookieValue)).username).toBe(REVOKED)

    // Upper case on the command line: the stored username is lowercased, and so is the argument.
    const result = await admin("revoke-sessions", "--user", REVOKED.toUpperCase())
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("1 admin session signed out")

    await expect(auth.authenticate(revoked.cookieValue)).rejects.toThrow()
    expect((await auth.authenticate(kept.cookieValue)).username).toBe(KEPT)
  },
  30_000,
)

test.skipIf(!runnable)(
  "revoke-sessions refuses a malformed argument and deletes nothing",
  async () => {
    const result = await admin("revoke-sessions", "--user")
    expect(result.code).toBe(2)
  },
  30_000,
)
