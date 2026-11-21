import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAccountReplicaLeaseRepository, createDatabase } from "@multi-ai-router/db"
import {
  ownDatabaseFixture,
  ownDatabaseUrl,
} from "../../../../packages/db/test/integration/own-database-fixture"
import { generationOwnedCredentials } from "../../src/composition/credential-ownership"
import { ownedInvoker } from "../../src/composition/owned-invoker"
import type { SdkInvocation } from "../../src/providers/claude-sdk/invoke"
import { createReplicaLeaseManager } from "../../src/providers/claude-sdk/replica-lease"
import {
  createReplicaStorage,
  createStorageAttachmentHelper,
} from "../../src/providers/claude-sdk/replica-storage"

const fixture = ownDatabaseFixture("replica_ownership")
describe.skipIf(!ownDatabaseUrl)("replica ownership runtime admission", () => {
  test("independent owners fence cached reads and streamed stub turns on loss", async () => {
    const other = createDatabase({ url: fixture.url(), maxConnections: 1 })
    const root = await mkdtemp(join(tmpdir(), "replica-runtime-"))
    const helper = join(root, "attach")
    await writeFile(
      helper,
      `#!/usr/bin/env python3
import json, os, sys
r = json.load(sys.stdin)
if r['operation'] == 'allocate':
    directory = os.path.join(r['root'], r['accountId'])
    os.mkdir(directory, 0o700)
    with open(os.path.join(directory, '.storage-identity'), 'x') as marker:
        marker.write(r['identity'])
r['exclusive'] = True
print(json.dumps(r))
`,
      { mode: 0o700 },
    )
    // Fixture helper models exclusive attachment. It is not evidence of remote storage fencing.
    const attachment = createReplicaStorage(root, "fixture-volume", {
      ...createStorageAttachmentHelper(helper, root, 1000),
      async retireLocalOwners() {},
      async drainMetadata() {},
    })
    const policy = { ttlMs: 10000, heartbeatMs: 1000, batchSize: 2 }
    const a = createReplicaLeaseManager(
      createAccountReplicaLeaseRepository(fixture.db()),
      attachment,
      policy,
    )
    const b = createReplicaLeaseManager(
      createAccountReplicaLeaseRepository(other.db),
      attachment,
      policy,
    )
    const id = crypto.randomUUID()
    const input: SdkInvocation = {
      accountId: id,
      configDir: join(root, id),
      model: "claude-test",
      body: null,
      signal: new AbortController().signal,
      session: { kind: "fresh", reason: "no-session" },
    }
    let starts = 0
    let reads = 0
    let forgotten = 0
    const cache = generationOwnedCredentials(
      {
        async read() {
          reads++
          return null
        },
        forget() {
          forgotten++
        },
      },
      a,
    )
    const stub = async () => {
      starts++
      return new Response(new ReadableStream<Uint8Array>())
    }
    try {
      expect(await a.ensure(id, true)).toBeDefined()
      await writeFile(join(root, id, "continuity"), "persistent-fixture")
      expect(await b.ensure(id)).toBeUndefined()
      await expect(ownedInvoker(b, stub)(input)).rejects.toThrow("ownership unavailable")
      expect(starts).toBe(0)
      await cache.read(id, input.configDir)
      await cache.read(id, input.configDir)
      expect(reads).toBe(2)
      const response = await ownedInvoker(a, stub)(input)
      const body = response.body?.getReader()
      if (!body) throw new Error("missing stream")
      const pending = body.read()
      await fixture.sql()`UPDATE account_replica_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE account_id = ${id}`
      await a.renew()
      await expect(pending).rejects.toThrow("ownership lost")
      const forgetsBeforeRefusal = forgotten
      await expect(cache.read(id, input.configDir)).rejects.toThrow("ownership unavailable")
      expect(forgotten).toBe(forgetsBeforeRefusal + 1)
      await expect(ownedInvoker(a, stub)(input)).rejects.toThrow("ownership unavailable")
      expect(starts).toBe(1)
      expect(reads).toBe(2)
      expect((await b.ensure(id))?.generation).toBe(2n)
      expect(await readFile(join(root, id, "continuity"), "utf8")).toBe("persistent-fixture")
    } finally {
      await a.stop(async () => {})
      await b.stop(async () => {})
      await other.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
