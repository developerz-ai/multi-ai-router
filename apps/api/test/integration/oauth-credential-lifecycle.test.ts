import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  type AccountRepository,
  type CredentialRefreshLockPoolHandle,
  createAccountRepository,
  createCredentialRefreshLockPool,
  createDatabase,
  createOauthStateRepository,
  credentialFingerprint,
  type DatabaseHandle,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import { createLogger } from "../../src/logging/logger"
import { OPENAI_AUTH_CLAIM } from "../../src/providers/drivers/openai-oauth"
import {
  createCredentialRefresher,
  createOAuthConnectService,
  readStoredOAuth,
  writeStoredOAuth,
} from "../../src/services/accounts"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
import { pasteOnlyFlow } from "../support/oauth-flows"

const url = process.env.DATABASE_URL ?? ""
const NOW = new Date("2026-10-03T12:00:00Z")
const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(19) })
const logger = createLogger({ level: "error", write: () => {} })
let database: DatabaseHandle | undefined
let locks: CredentialRefreshLockPoolHandle | undefined
let accounts: AccountRepository
const ids: string[] = []
const auxiliary: CredentialRefreshLockPoolHandle[] = []
const refreshers: ReturnType<typeof createCredentialRefresher>[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function jwt(id: string): string {
  return `header.${Buffer.from(JSON.stringify({ [OPENAI_AUTH_CLAIM]: { chatgpt_account_id: id } })).toString("base64url")}.sig`
}
function response(access = "opaque", refresh = "R2", id = "account-id"): Response {
  return new Response(
    JSON.stringify({
      access_token: access,
      refresh_token: refresh,
      id_token: jwt(id),
      expires_in: 3_600,
    }),
    { headers: { "content-type": "application/json" } },
  )
}
async function seed() {
  const row = await accounts.create({
    label: `oauth-lifecycle-${crypto.randomUUID()}`,
    provider: "openai-oauth",
    authMaterial: cipher.encrypt(
      writeStoredOAuth({ accessToken: "held", refreshToken: "R", providerAccountId: "account-id" }),
    ),
    tokenExpiresAt: new Date(NOW.getTime() + 100_000),
  })
  ids.push(row.id)
  return row
}
beforeAll(async () => {
  if (!url) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  database = createDatabase({ url, maxConnections: 1 })
  accounts = createAccountRepository(database.db)
  locks = createCredentialRefreshLockPool({ url, maxConnections: 1 })
})
afterAll(async () => {
  await Promise.all(refreshers.map((r) => r.stop()))
  await locks?.close()
  await Promise.all(auxiliary.map((lock) => lock.close()))
  if (database !== undefined) for (const id of ids) await accounts.delete(id)
  await database?.close()
})
function connector(fetch: (request: Request) => Promise<Response>, barrier = async () => {}) {
  if (database === undefined) throw new Error("missing disposable database")
  return createOAuthConnectService({
    accounts,
    states: createOauthStateRepository(database.db),
    cipher,
    audit: { record: async () => {} },
    fetch,
    exchangeTimeoutMs: 5_000,
    now: () => NOW,
    stateMinutes: 10,
    refreshCatalogAfterMutation: barrier,
    flowFor: pasteOnlyFlow,
  })
}
function refresher(fetch: (request: Request) => Promise<Response>, lock = locks) {
  if (lock === undefined) throw new Error("missing dedicated refresh locks")
  const instance = createCredentialRefresher({
    accounts,
    refreshLock: lock,
    cipher,
    audit: { record: async () => {} },
    fetch,
    logger,
    now: () => NOW,
    refreshCatalogAfterMutation: async () => {},
    config: { leadFraction: 0.75, minDelayMs: 1_000, maxAttempts: 2, timeoutMs: 5_000 },
  })
  refreshers.push(instance)
  return instance
}

describe.skipIf(!url)("a parked account's refresh against real rows", () => {
  const park = async () => {
    const row = await seed()
    const parked = await accounts.transitionObservedStatus({
      id: row.id,
      expected: {
        lifecycleVersion: row.lifecycleVersion,
        authMaterial: row.authMaterial,
        status: row.status,
      },
      status: "needs_reauth",
      now: NOW,
    })
    if (parked === undefined) throw new Error("seed row did not park")
    return parked
  }

  test("a working refresh ends the park and bumps the auth epoch in one write", async () => {
    const row = await park()
    let exchanges = 0
    const instance = refresher(async () => {
      exchanges++
      return response()
    })

    expect((await instance.refreshNow(row.id)).kind).toBe("success")

    const after = await accounts.findById(row.id)
    expect(after?.status).toBe("active")
    expect(after?.authMaterial).not.toBe(row.authMaterial)
    expect(after?.authRecoveryVersion).toBe(row.authRecoveryVersion + 1)
    expect(after?.lifecycleVersion).toBe(row.lifecycleVersion + 1)
    expect(after?.authRefreshSpentOn).toBe(credentialFingerprint(after?.authMaterial ?? null))
    expect(exchanges).toBe(1)
  })

  test("the credential a refresh produced gets no second one when it is refused too", async () => {
    const row = await park()
    let exchanges = 0
    const instance = refresher(async () => {
      exchanges++
      return response()
    })
    await instance.refreshNow(row.id)
    const revived = await accounts.findById(row.id)
    if (revived === undefined) throw new Error("row vanished")
    await accounts.transitionObservedStatus({
      id: row.id,
      expected: {
        lifecycleVersion: revived.lifecycleVersion,
        authMaterial: revived.authMaterial,
        status: revived.status,
      },
      status: "needs_reauth",
      now: NOW,
    })

    expect(await instance.refreshNow(row.id)).toMatchObject({ reason: "not-refreshable" })
    expect(exchanges).toBe(1)
  })

  test("a refusal is durable across a new process, and a re-check releases it", async () => {
    const row = await park()
    const refused = async () => new Response("{}", { status: 400 })
    await refresher(refused).refreshNow(row.id)

    const nextBoot = refresher(async () => response())
    expect(await nextBoot.refreshNow(row.id)).toMatchObject({ reason: "not-refreshable" })
    expect((await accounts.findById(row.id))?.status).toBe("needs_reauth")

    expect((await nextBoot.retryParked(row.id)).kind).toBe("success")
    expect((await accounts.findById(row.id))?.status).toBe("active")
  })

  test("an operator's disable survives a refresh that lands behind it", async () => {
    const row = await seed()
    await accounts.reviveRefreshedCredential({
      id: row.id,
      expectedAuthMaterial: row.authMaterial as string,
      authMaterial: "v1.rotated",
      tokenExpiresAt: null,
      now: NOW,
    })
    await accounts.updateOperatorAccount({ id: row.id, patch: { status: "disabled" }, now: NOW })

    const after = await accounts.reviveRefreshedCredential({
      id: row.id,
      expectedAuthMaterial: "v1.rotated",
      authMaterial: "v1.rotated-again",
      tokenExpiresAt: null,
      now: NOW,
    })

    expect(after?.status).toBe("disabled")
    expect(after?.authMaterial).toBe("v1.rotated-again")
  })
})

describe.skipIf(!url)("OAuth services with real CAS and dedicated pool (main max1)", () => {
  test("two instances spend one rotating grant under contention", async () => {
    const row = await seed()
    const entered = deferred<void>()
    const issuer = deferred<Response>()
    let exchanges = 0
    const fetch = async (request: Request) => {
      expect(request.url).toBe("https://auth.openai.com/oauth/token")
      expect(JSON.parse(await request.text()).refresh_token).toBe("R")
      exchanges++
      entered.resolve()
      return issuer.promise
    }
    const owner = refresher(fetch)
    const independent = createCredentialRefreshLockPool({ url, maxConnections: 1 })
    auxiliary.push(independent)
    const peer = refresher(fetch, independent)
    const flight = owner.refreshNow(row.id)
    await entered.promise
    expect(await peer.refreshNow(row.id)).toMatchObject({ kind: "skipped", reason: "busy" })
    issuer.resolve(response())
    expect((await flight).kind).toBe("success")
    expect(exchanges).toBe(1)
    const stored = await accounts.findById(row.id)
    expect(readStoredOAuth(cipher.decrypt(stored?.authMaterial as string))?.refreshToken).toBe("R2")
    expect(stored?.status).toBe("active")
    await owner.stop()
    await peer.stop()
  })

  test("cancel or later begin defeats an already consumed paused code exchange", async () => {
    const row = await seed()
    const entered = deferred<void>()
    const issuer = deferred<Response>()
    const connect = connector(async () => {
      entered.resolve()
      return issuer.promise
    })
    const a = await connect.begin(row.id, "reconnect")
    if (!a.ok) throw new Error("begin A failed")
    const stateA = new URL(a.value.authorizeUrl).searchParams.get("state")
    const old = connect.complete(row.id, `code-A#${stateA}`)
    await entered.promise
    const b = await connect.begin(row.id, "reconnect")
    expect(b.ok).toBe(true)
    expect(await connect.cancel(row.id)).toMatchObject({ ok: true, value: { cancelled: true } })
    issuer.resolve(response("stale-code-access"))
    expect(await old).toMatchObject({ ok: false, failure: { code: "authorization_superseded" } })
    expect((await accounts.findById(row.id))?.authMaterial).toBe(row.authMaterial)
  })

  test("refresh while login pending changes ciphertext but does not invalidate attempt", async () => {
    const row = await seed()
    const connect = connector(async () => response("login-token", "login-R", "new-identity"))
    const begun = await connect.begin(row.id, "reconnect")
    if (!begun.ok) throw new Error("begin failed")
    const pending = await accounts.findById(row.id)
    const refresh = refresher(async () => response("refreshed-token", "R2"))
    expect((await refresh.refreshNow(row.id)).kind).toBe("success")
    expect((await accounts.findById(row.id))?.authorizationAttemptId).toBe(
      pending?.authorizationAttemptId,
    )
    const state = new URL(begun.value.authorizeUrl).searchParams.get("state")
    expect(await connect.complete(row.id, `code#${state}`)).toMatchObject({ ok: true })
    const stored = await accounts.findById(row.id)
    expect(stored).toMatchObject({
      lifecycleVersion: 1,
      authRecoveryVersion: 1,
      healthRecoveryVersion: 0,
    })
    expect(readStoredOAuth(cipher.decrypt(stored?.authMaterial as string))).toMatchObject({
      accessToken: "login-token",
      providerAccountId: "new-identity",
    })
    await refresh.stop()
  })

  test("disable while refresh paused retains rotated grant and operator intent", async () => {
    const row = await seed()
    const entered = deferred<void>()
    const issuer = deferred<Response>()
    const refresh = refresher(async () => {
      entered.resolve()
      return issuer.promise
    })
    const flight = refresh.refreshNow(row.id)
    await entered.promise
    await accounts.updateOperatorAccount({ id: row.id, patch: { status: "disabled" }, now: NOW })
    issuer.resolve(response())
    expect(await flight).toMatchObject({
      kind: "success",
      row: { status: "disabled", lifecycleVersion: 1 },
    })
    const stored = await accounts.findById(row.id)
    expect(readStoredOAuth(cipher.decrypt(stored?.authMaterial as string))?.refreshToken).toBe("R2")
    expect(stored).toMatchObject({
      status: "disabled",
      authRecoveryVersion: 0,
      healthRecoveryVersion: 0,
    })
    await refresh.stop()
  })

  test("saved authorization with failed strict barrier is not reported as redemption failure", async () => {
    const row = await seed()
    const connect = connector(
      async () => response("committed"),
      async () => {
        throw new Error("catalog down")
      },
    )
    const begun = await connect.begin(row.id, "reconnect")
    if (!begun.ok) throw new Error("begin failed")
    const state = new URL(begun.value.authorizeUrl).searchParams.get("state")
    expect(await connect.complete(row.id, `code#${state}`)).toMatchObject({
      ok: false,
      failure: { code: "routing_unavailable" },
    })
    expect(
      readStoredOAuth(cipher.decrypt((await accounts.findById(row.id))?.authMaterial as string))
        ?.accessToken,
    ).toBe("committed")
  })
})
