import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { Readable, Writable } from "node:stream"
import type { ReplicaLeaseToken } from "@multi-ai-router/db"
import { makeAnchoredRoot } from "./config-dir-fs"
import type { ExclusiveStorageAttachment, ReplicaStorage } from "./replica-storage-types"

export type { ExclusiveStorageAttachment, ReplicaStorage } from "./replica-storage-types"

/** Single-node mode pins a random persistent volume identity and holds a root-wide kernel lock. */
export function createLocalReplicaStorage(
  root: string,
  helper: string,
  drains: Pick<ExclusiveStorageAttachment, "retireLocalOwners" | "drainMetadata">,
) {
  let identity = ""
  let control: Writable | undefined
  let exit: Promise<void> | undefined
  let live = false
  let storage: ReplicaStorage | undefined
  let initializing: Promise<void> | undefined
  const initialize = () =>
    (initializing ??= (async () => {
      await makeAnchoredRoot(root, 0o700)
      const child = spawn(helper, ["storage-local", root, randomUUID()], {
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
        env: {},
      })
      control = child.stdio[4] as Writable
      const status = child.stdio[3] as Readable
      exit = new Promise<void>((resolve, reject) => {
        child.once("error", () => reject(new Error("local storage guardian unavailable")))
        child.once("close", (code) => {
          live = false
          if (code === 0) resolve()
          else reject(new Error("local storage guardian retirement uncertain"))
        })
      })
      void exit.catch(() => {})
      await new Promise<void>((resolve, reject) => {
        status.once("data", (data: Buffer) => {
          if (data.toString() === "R") {
            live = true
            resolve()
          } else reject(new Error("local storage admission refused"))
        })
        child.once("error", () => reject(new Error("local storage admission unavailable")))
        child.once("close", () => reject(new Error("local storage admission refused")))
      })
      if ((await realpath(root)) !== root) throw new Error("local storage root is not anchored")
      const marker = join(root, ".replica-storage-identity")
      try {
        await writeFile(marker, randomUUID(), { flag: "wx", mode: 0o600 })
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      }
      const file = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        identity = await file.readFile("utf8")
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size !== 36 ||
          !/^[0-9a-f-]{36}$/.test(identity)
        )
          throw new Error("local storage identity refused")
      } finally {
        await file.close()
      }
      storage = createReplicaStorage(root, identity, adapter)
    })())
  const adapter: ExclusiveStorageAttachment = {
    ...drains,
    confirm: async () => live,
    async provisionNew(token) {
      await mkdir(join(root, token.accountId), { mode: 0o700 })
      await writeFile(join(root, token.accountId, ".storage-identity"), identity, {
        flag: "wx",
        mode: 0o600,
      })
    },
  }
  return {
    get identity() {
      return identity
    },
    async attach(token: ReplicaLeaseToken, previous: string | null) {
      await initialize()
      if (previous !== null && previous !== identity)
        throw new Error("assigned local storage mismatch")
      // Import legacy directories only on the original, exclusively locked volume.
      if (previous === null) {
        const path = join(root, token.accountId)
        const stat = await lstat(path)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("local directory refused")
        try {
          await writeFile(join(path, ".storage-identity"), identity, { flag: "wx", mode: 0o600 })
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
        }
      }
      if (!storage) throw new Error("local storage unavailable")
      await storage.attach(token, previous)
    },
    async provisionNew(token: ReplicaLeaseToken) {
      await initialize()
      if (!storage) throw new Error("local storage unavailable")
      await storage.provisionNew(token)
    },
    async stop() {
      control?.end()
      await exit
    },
  }
}

/** The helper is the storage authority, not a credential reader. Its stdout is a bounded receipt. */
export function createStorageAttachmentHelper(
  helperPath: string,
  root: string,
  timeoutMs: number,
): Pick<ExclusiveStorageAttachment, "confirm" | "provisionNew"> {
  const invoke = (operation: "confirm" | "allocate", token: ReplicaLeaseToken, identity: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "ignore"], env: {} })
      let receipt = ""
      let invalid = false
      const timer = setTimeout(() => {
        invalid = true
        child.kill("SIGKILL")
      }, timeoutMs)
      child.stdout.on("data", (chunk: Buffer) => {
        if (receipt.length + chunk.length > 2048) {
          invalid = true
          child.kill("SIGKILL")
        } else receipt += chunk.toString("utf8")
      })
      child.stdin.on("error", () => {
        invalid = true
      })
      child.once("error", () => {
        clearTimeout(timer)
        reject(new Error("storage attachment helper unavailable"))
      })
      child.once("close", (code) => {
        clearTimeout(timer)
        try {
          const value: unknown = JSON.parse(receipt)
          if (invalid || code !== 0 || typeof value !== "object" || value === null)
            throw new Error("invalid receipt")
          const expected = {
            version: 1,
            operation,
            accountId: token.accountId,
            owner: token.owner,
            generation: String(token.generation),
            identity,
            exclusive: true,
          }
          for (const [key, entry] of Object.entries(expected))
            if (Reflect.get(value, key) !== entry) throw new Error("invalid receipt")
          resolve()
        } catch {
          reject(new Error("storage attachment receipt refused"))
        }
      })
      child.stdin.end(
        `${JSON.stringify({
          version: 1,
          operation,
          root,
          accountId: token.accountId,
          owner: token.owner,
          generation: String(token.generation),
          identity,
        })}\n`,
      )
    })
  return {
    async confirm(token, identity) {
      await invoke("confirm", token, identity)
      return true
    },
    provisionNew: (token, identity) => invoke("allocate", token, identity),
  }
}

/** Validation only. Never creates directories or copies live credentials during takeover. */
export function createReplicaStorage(
  root: string,
  identity: string,
  attachment: ExclusiveStorageAttachment,
): ReplicaStorage {
  if (resolve(root) !== root || !identity.length || identity.length > 512)
    throw new Error("invalid replica storage configuration")
  const pending = new Map<string, Promise<void>>()
  const exclusive = async (
    token: ReplicaLeaseToken,
    task: () => Promise<void>,
    allocate = false,
  ) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token.accountId))
      throw new Error("invalid account storage identity")
    const previous = pending.get(token.accountId)
    const work = (async () => {
      // A rejected drain is not proof of quiescence and cannot be bypassed by a successor.
      await previous
      try {
        await attachment.retireLocalOwners(token.accountId)
        await attachment.drainMetadata(token.accountId)
      } catch (error) {
        // Only uncertain retirement permanently parks this process's storage admission.
        pending.set(token.accountId, Promise.reject(error))
        void pending.get(token.accountId)?.catch(() => {})
        throw error
      }
      if (!allocate && !(await attachment.confirm(token, identity)))
        throw new Error("exclusive storage attachment unconfirmed")
      await task()
      if (!(await attachment.confirm(token, identity)))
        throw new Error("exclusive storage attachment lost")
    })()
    pending.set(token.accountId, work)
    try {
      await work
    } finally {
      if (pending.get(token.accountId) === work) pending.delete(token.accountId)
    }
  }
  const storage: ReplicaStorage = {
    identity,
    async provisionNew(token) {
      if (!attachment.provisionNew) throw new Error("new account storage authority unavailable")
      const provision = attachment.provisionNew.bind(attachment)
      await exclusive(token, () => provision(token, identity), true)
      await storage.attach(token, null)
    },
    async attach(token, previousIdentity) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token.accountId))
        throw new Error("invalid account storage identity")
      if (previousIdentity !== null && previousIdentity !== identity)
        throw new Error("assigned account storage mismatch")
      await exclusive(token, async () => {
        if ((await realpath(root)) !== root) throw new Error("storage root is not anchored")
        const path = join(root, token.accountId)
        const state = await lstat(path)
        if (!state.isDirectory() || state.isSymbolicLink())
          throw new Error("account storage is not anchored")
        const directory = await open(
          path,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        )
        try {
          const opened = await directory.stat()
          if (opened.dev !== state.dev || opened.ino !== state.ino)
            throw new Error("account storage changed during attachment")
          // Identity is an operator-provisioned, non-secret marker on the persistent volume.
          const marker = await open(
            `/proc/self/fd/${directory.fd}/.storage-identity`,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          )
          try {
            const stat = await marker.stat()
            if (
              !stat.isFile() ||
              stat.size > 512 ||
              stat.nlink !== 1 ||
              (await marker.readFile("utf8")) !== identity
            )
              throw new Error("account storage identity mismatch")
          } finally {
            await marker.close()
          }
        } finally {
          await directory.close()
        }
        const current = await lstat(path)
        if (
          current.dev !== state.dev ||
          current.ino !== state.ino ||
          (await realpath(root)) !== root
        )
          throw new Error("account storage changed during attachment")
      })
    },
  }
  return storage
}
