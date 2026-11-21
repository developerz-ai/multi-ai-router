import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createReplicaStorage,
  createStorageAttachmentHelper,
  type ExclusiveStorageAttachment,
} from "../../../src/providers/claude-sdk/replica-storage"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "replica-storage-"))
  const token = { accountId: crypto.randomUUID(), owner: crypto.randomUUID(), generation: 2n }
  const path = join(root, token.accountId)
  const calls: string[] = []
  const adapter: ExclusiveStorageAttachment = {
    async confirm() {
      calls.push("exclusive")
      return true
    },
    async retireLocalOwners() {
      calls.push("drained")
    },
    async drainMetadata() {
      calls.push("metadata")
    },
  }
  return {
    root,
    token,
    path,
    calls,
    adapter,
    storage: () => createReplicaStorage(root, "volume-one", adapter),
    async populate() {
      await mkdir(path)
      await writeFile(join(path, ".storage-identity"), "volume-one")
    },
    async dispose() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("replica-lease storage reattaches the same directory after both drains and reconfirmation", async () => {
  const f = await fixture()
  try {
    await f.populate()
    await writeFile(join(f.path, "synthetic-credentials"), "fixture-only")
    await writeFile(join(f.path, "transcript"), "retained")
    await f.storage().attach(f.token, "volume-one")
    expect(f.calls).toEqual(["drained", "metadata", "exclusive", "exclusive"])
    expect(await readFile(join(f.path, "synthetic-credentials"), "utf8")).toBe("fixture-only")
    expect(await readFile(join(f.path, "transcript"), "utf8")).toBe("retained")
  } finally {
    await f.dispose()
  }
})

for (const invalid of ["missing", "empty", "foreign", "symlink", "marker-symlink"] as const) {
  test(`replica-lease storage refuses ${invalid} takeover storage without replacement`, async () => {
    const f = await fixture()
    try {
      if (invalid === "symlink") await symlink(f.root, f.path)
      else if (invalid !== "missing") {
        await mkdir(f.path)
        if (invalid === "foreign") await writeFile(join(f.path, ".storage-identity"), "volume-two")
        if (invalid === "marker-symlink") {
          await writeFile(join(f.root, "identity"), "volume-one")
          await symlink(join(f.root, "identity"), join(f.path, ".storage-identity"))
        }
      }
      await expect(f.storage().attach(f.token, "volume-one")).rejects.toThrow()
      if (invalid === "missing")
        await expect(readFile(join(f.path, ".storage-identity"))).rejects.toThrow()
    } finally {
      await f.dispose()
    }
  })
}

test("replica-lease assigned storage identity mismatch refuses before draining", async () => {
  const f = await fixture()
  try {
    await f.populate()
    await expect(f.storage().attach(f.token, "volume-two")).rejects.toThrow("mismatch")
    expect(f.calls).toEqual([])
  } finally {
    await f.dispose()
  }
})

test("replica-lease pending metadata blocks attachment and successor validation", async () => {
  const f = await fixture()
  let release = () => {}
  let entered = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.adapter.drainMetadata = async () => {
    entered()
    await pending
  }
  try {
    await f.populate()
    const storage = f.storage()
    let attached = 0
    const first = storage.attach(f.token, "volume-one").then(() => {
      attached++
    })
    await started
    const second = storage.attach({ ...f.token, generation: 3n }, "volume-one").then(() => {
      attached++
    })
    await Promise.resolve()
    expect(attached).toBe(0)
    expect(f.calls).toEqual(["drained"])
    release()
    await Promise.all([first, second])
    expect(attached).toBe(2)
    expect(f.calls).toEqual([
      "drained",
      "exclusive",
      "exclusive",
      "drained",
      "exclusive",
      "exclusive",
    ])
  } finally {
    release()
    await f.dispose()
  }
})

for (const stage of ["retireLocalOwners", "drainMetadata"] as const) {
  test(`replica-lease rejected ${stage} cannot be bypassed by a successor`, async () => {
    const f = await fixture()
    try {
      await f.populate()
      f.adapter[stage] = async () => {
        throw new Error("drain uncertain")
      }
      const storage = f.storage()
      await expect(storage.attach(f.token, "volume-one")).rejects.toThrow("drain uncertain")
      f.adapter[stage] = async () => {}
      const calls = [...f.calls]
      await expect(storage.attach({ ...f.token, generation: 3n }, "volume-one")).rejects.toThrow(
        "drain uncertain",
      )
      expect(f.calls).toEqual(calls)
    } finally {
      await f.dispose()
    }
  })
}

for (const loseAfterValidation of [false, true]) {
  test(`replica-lease refuses unconfirmed exclusive attachment, recheck=${loseAfterValidation}`, async () => {
    const f = await fixture()
    let confirmations = 0
    f.adapter.confirm = async () => ++confirmations === 1 && loseAfterValidation
    try {
      await f.populate()
      await expect(f.storage().attach(f.token, "volume-one")).rejects.toThrow(
        "exclusive storage attachment",
      )
      expect(confirmations).toBe(loseAfterValidation ? 2 : 1)
    } finally {
      await f.dispose()
    }
  })
}

test("replica-lease new allocation requires separate persistent allocation authority", async () => {
  const f = await fixture()
  try {
    await expect(f.storage().provisionNew(f.token)).rejects.toThrow("authority unavailable")
    expect(f.calls).toEqual([])
    f.adapter.provisionNew = async (token, identity) => {
      expect(token).toEqual(f.token)
      expect(identity).toBe("volume-one")
      f.calls.push("allocate")
      await f.populate()
    }
    await f.storage().provisionNew(f.token)
    expect(f.calls).toEqual([
      "drained",
      "metadata",
      "allocate",
      "exclusive",
      "drained",
      "metadata",
      "exclusive",
      "exclusive",
    ])
    f.adapter.provisionNew = async () => {
      throw new Error("already allocated")
    }
    await expect(f.storage().provisionNew(f.token)).rejects.toThrow("already allocated")
  } finally {
    await f.dispose()
  }
})

test("production attachment helper validates generation receipts and first allocation", async () => {
  const f = await fixture()
  const helper = join(f.root, "attach")
  try {
    await writeFile(
      helper,
      `#!/usr/bin/env python3
import json, os, sys
request = json.load(sys.stdin)
if request['operation'] == 'allocate':
    path = os.path.join(request['root'], request['accountId'])
    os.mkdir(path, 0o700)
    with open(os.path.join(path, '.storage-identity'), 'x') as marker:
        marker.write(request['identity'])
request['exclusive'] = True
print(json.dumps(request))
`,
      { mode: 0o700 },
    )
    const authority = createStorageAttachmentHelper(helper, f.root, 1000)
    const storage = createReplicaStorage(f.root, "volume-one", { ...f.adapter, ...authority })
    await storage.provisionNew(f.token)
    await writeFile(join(f.path, "continuity"), "retained")
    await storage.attach({ ...f.token, generation: 3n }, "volume-one")
    expect(await readFile(join(f.path, "continuity"), "utf8")).toBe("retained")
    await writeFile(helper, "#!/bin/sh\nprintf '%s' '{\"exclusive\":true}'\n", { mode: 0o700 })
    await expect(authority.confirm(f.token, "volume-one")).rejects.toThrow("receipt refused")
  } finally {
    await f.dispose()
  }
})
