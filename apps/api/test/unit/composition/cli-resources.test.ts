/**
 * Deleting an HTTP Account takes no replica lease: it has no directory, so nothing to fence. The
 * lease assert ran before anyone looked, and every such delete failed. A subscription Account's
 * delete still needs its lease, or two replicas could remove one directory.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliResources } from "../../../src/composition/cli-resources"

const root = mkdtempSync(join(tmpdir(), "cli-resources-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const noop = () => {}
const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger }
const { ownership } = createCliResources(
  {
    env: {
      claudeConfigRoot: root,
      claudeSdkMaxConcurrency: 1,
      claudeSdkMaxConcurrencyPerAccount: 1,
      cliOwnership: {
        helperPath: "/nonexistent/helper",
        operationTimeoutMs: 100,
        cleanupMaximumEntries: 10,
        cleanupMaximumDepth: 2,
        replicaLease: {
          storageAttachment: "none",
          batchSize: 1,
          ttlMs: 60_000,
          heartbeatMs: 10_000,
        },
      },
      background: { shutdownDrainMs: 10 },
      claudeSdkSessionCarry: { enabled: false },
    },
    logger,
    database: {},
  } as unknown as Parameters<typeof createCliResources>[0],
  () => new Date(),
  { tryAcquire: async () => null } as never,
)

const id = "11111111-1111-4111-8111-111111111111"

test("an HTTP account is revoked and cleaned up with no lease held", async () => {
  await expect(
    Promise.resolve(ownership.revokeDeletedAccount({ id, configDir: null })),
  ).resolves.toBeUndefined()
  expect(await ownership.cleanupDeletedAccount({ id, configDir: null })).toBe("not_applicable")
})

test("a subscription account is still refused without its lease", () => {
  const account = { id, configDir: join(root, id) }
  expect(() => ownership.revokeDeletedAccount(account)).toThrow("replica ownership unavailable")
  expect(() => ownership.cleanupDeletedAccount(account)).toThrow("replica ownership unavailable")
})
