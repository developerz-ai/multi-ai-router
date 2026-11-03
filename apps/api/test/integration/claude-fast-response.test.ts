import { expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDatabase } from "@multi-ai-router/db"
import { createCliResources } from "../../src/composition/cli-resources"
import { createRequestServices } from "../../src/composition/request-services"
import { createRuntimeRepositories } from "../../src/composition/runtime-repositories"
import { createRuntimeTelemetry } from "../../src/composition/runtime-telemetry"
import { createWarmState } from "../../src/composition/warm-state"
import { parseEnv } from "../../src/config/env"
import { createLogger } from "../../src/logging/logger"
import * as availability from "../../src/providers/claude-fast/availability"
import * as credentialReader from "../../src/providers/claude-fast/credential"
import * as fastInvoker from "../../src/providers/claude-fast/invoker"
import { createFastInvoker, type FastInvokerDeps } from "../../src/providers/claude-fast/invoker"
import { createSdkConcurrency } from "../../src/providers/claude-sdk/concurrency"
import { UpstreamAdmissionRefused } from "../../src/providers/upstream-admission"
import { createCredentialCipherFromEnv } from "../../src/services/crypto/fromEnv"
import { subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, harness, post, settle } from "./harness"

test("composition fences fast credentials by selected Account directory and metadata owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "fast-composition-"))
  const restore: (() => void)[] = []
  const cleanup: (() => Promise<unknown>)[] = [() => rm(root, { recursive: true, force: true })]
  try {
    const env = parseEnv({
      DATABASE_URL: "postgres://nobody:nobody@127.0.0.1:1/none",
      ADMIN_OIDC_ISSUER_URL: "https://sso.test",
      ADMIN_OIDC_CLIENT_ID: "fast-composition-test",
      ADMIN_OIDC_REDIRECT_URI: "https://router.test/api/admin/auth/oidc/callback",
      ADMIN_OIDC_ADMIN_EMAIL: "admin@test",
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      CLAUDE_CONFIG_ROOT: root,
      CLAUDE_FAST_MODE: "true",
    })
    // Lazy pools only: no runtime start, query, CLI launch, or inference.
    const handle = createDatabase({ url: env.databaseUrl })
    cleanup.push(() => handle.close())
    const deps = {
      env,
      database: handle.db,
      sql: handle.sql,
      dbPoolStats: handle.poolStats,
      logger: createLogger({ level: "error", write: () => undefined }),
    }
    const now = () => new Date("2026-01-01T12:00:00Z")
    const repositories = createRuntimeRepositories(deps)
    cleanup.push(
      () => repositories.refreshLock.close(),
      () => repositories.schedulerLock.close(),
    )
    const warm = createWarmState(deps, repositories, now)
    const cli = createCliResources(deps, now, repositories.refreshLock)
    cleanup.push(() => cli.ownership.stop())
    const telemetry = createRuntimeTelemetry(deps, repositories, warm, cli, now)
    const fixtures = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        accessToken: "synthetic-account-one-token",
        deviceId: "a".repeat(64),
        accountUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        accessToken: "synthetic-account-two-token",
        deviceId: "b".repeat(64),
        accountUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    ]
    const expiresAt = now().getTime() + 3_600_000
    for (const fixture of fixtures) {
      const dir = cli.configDirs.pathFor(fixture.id)
      await mkdir(dir, { mode: 0o700 })
      await writeFile(
        join(dir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: fixture.accessToken, expiresAt } }),
        { mode: 0o600 },
      )
      await writeFile(
        join(dir, ".claude.json"),
        JSON.stringify({
          userID: fixture.deviceId,
          oauthAccount: { accountUuid: fixture.accountUuid },
        }),
        { mode: 0o600 },
      )
    }

    let activeOwner: string | undefined
    const ownerIds: string[] = []
    const ownerSpy = spyOn(cli.ownership, "withMetadataOwner").mockImplementation(
      async (id, task) => {
        expect(activeOwner).toBeUndefined()
        ownerIds.push(id)
        activeOwner = id
        try {
          return await task()
        } finally {
          activeOwner = undefined
        }
      },
    )
    restore.push(() => ownerSpy.mockRestore())
    const read = credentialReader.readFastCredential
    const readerSpy = spyOn(credentialReader, "readFastCredential").mockImplementation(
      async (dir) => {
        const fixture = fixtures.find((entry) => cli.configDirs.pathFor(entry.id) === dir)
        expect(fixture).toBeDefined()
        // Assert before real I/O; a missing or wrong-account owner must fail here.
        expect(activeOwner).toBe(fixture?.id)
        expect(activeOwner).toBeDefined()
        const result = await read(dir)
        expect(activeOwner).toBe(fixture?.id)
        return result
      },
    )
    restore.push(() => readerSpy.mockRestore())
    const profileSpy = spyOn(availability, "fastProfileState").mockReturnValue("verified")
    restore.push(() => profileSpy.mockRestore())
    const captured: FastInvokerDeps[] = []
    const create = fastInvoker.createFastInvoker
    const invokerSpy = spyOn(fastInvoker, "createFastInvoker").mockImplementation((options) => {
      captured.push(options)
      return create(options)
    })
    restore.push(() => invokerSpy.mockRestore())
    createRequestServices(
      deps,
      repositories,
      warm,
      cli,
      telemetry,
      createCredentialCipherFromEnv(env),
      now,
    )
    expect(captured).toHaveLength(1)
    const options = captured[0]
    if (!options) throw new Error("composition did not create the fast invoker")

    for (const selected of fixtures) {
      for (const other of fixtures.filter((entry) => entry.id !== selected.id)) {
        // The other directory contains valid credentials; refusal must precede both gates.
        expect(() => options.credential(selected.id, cli.configDirs.pathFor(other.id))).toThrow(
          UpstreamAdmissionRefused,
        )
        expect(ownerSpy).not.toHaveBeenCalled()
        expect(readerSpy).not.toHaveBeenCalled()
        expect(activeOwner).toBeUndefined()
      }
    }
    for (const [index, selected] of fixtures.entries()) {
      const dir = cli.configDirs.pathFor(selected.id)
      expect(await options.credential(selected.id, dir)).toEqual({
        accessToken: selected.accessToken,
        expiresAt,
        deviceId: selected.deviceId,
        accountUuid: selected.accountUuid,
      })
      expect(ownerSpy).toHaveBeenCalledTimes(index + 1)
      expect(readerSpy).toHaveBeenCalledTimes(index + 1)
      expect(readerSpy).toHaveBeenNthCalledWith(index + 1, dir)
      expect(ownerIds).toEqual(fixtures.slice(0, index + 1).map((entry) => entry.id))
      expect(activeOwner).toBeUndefined()
    }
  } finally {
    for (const undo of restore.reverse()) undo()
    await Promise.all(cleanup.reverse().map((close) => close()))
  }
})

for (const stream of [true, false]) {
  test(`fast mode refuses proxy HTTP 200 before client bytes and records failure (stream=${stream})`, async () => {
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    let sdkCalls = 0
    const invokeSdk = createFastInvoker({
      concurrency,
      errorMaxBytes: 4096,
      credential: async () => ({
        accessToken: "private-selected-account",
        expiresAt: Date.now() + 3_600_000,
        deviceId: "a".repeat(64),
        accountUuid: "11111111-1111-4111-8111-111111111111",
      }),
      resolveModel: (_, model) => model,
      sdk: async () => {
        sdkCalls++
        return new Response("unexpected fallback")
      },
      fetch: async () =>
        new Response("<html>private-selected-account</html>", {
          headers: { "content-type": "text/html" },
        }),
    })
    const { app, usage } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [],
      maxAttempts: 1,
      invokeSdk,
    })
    const response = await app.request(
      "/v1/messages",
      post(
        JSON.stringify({
          model: "claude-opus-5",
          max_tokens: 64,
          stream,
          messages: [{ role: "user", content: "hello" }],
        }),
        bearer(),
      ),
    )
    const text = await response.text()
    await settle()
    expect(response.status).toBe(502)
    expect(text).not.toContain("private-selected-account")
    expect(text).not.toContain("<html>")
    expect(sdkCalls).toBe(0)
    expect(concurrency.inFlight).toBe(0)
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ accountId: "sub", outcome: "upstream_error" })
  })
}
