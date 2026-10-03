import type { ChildProcess } from "node:child_process"
import { join } from "node:path"
import { UpstreamAdmissionRefused } from "../upstream-admission"
import { makeAnchoredRoot } from "./config-dir-fs"
import type { OwnerLaunchFactory } from "./owned-query"
import { createOwnerLaunch, type OwnerLaunch, type OwnerLaunchConfig } from "./owner-launch"

import { type OwnershipOperationDependencies, ownershipOperation } from "./ownership-operation"

export interface AccountOwnershipConfig extends OwnerLaunchConfig {
  readonly cleanupMaximumEntries: number
  readonly cleanupMaximumDepth: number
  readonly operationTimeoutMs: number
  readonly shutdownDrainMs: number
}
export interface AccountCliOwnership {
  readonly ownerLaunch: OwnerLaunchFactory
  provisionAccount(input: { id: string; configDir: string }): Promise<string>
  revokeDeletedAccount(input: { id: string; configDir: string | null }): Promise<void>
  cleanupDeletedAccount(input: {
    id: string
    configDir: string | null
  }): Promise<"removed" | "deferred" | "not_applicable">
  withMetadataOwner<T>(accountId: string, task: () => Promise<T>): Promise<T>
  closeAdmission(): void
  stop(): Promise<void>
}
export function createAccountCliOwnership(
  config: AccountOwnershipConfig,
  operationDependencies?: OwnershipOperationDependencies,
): AccountCliOwnership {
  const operation = (config: AccountOwnershipConfig, mode: string, id: string, args: string[]) =>
    ownershipOperation(config, mode, id, args, operationDependencies)
  let closed = false
  const live = new Map<string, Set<OwnerLaunch>>()
  const scopes = new Set<OwnerLaunch>()
  const metadata = new Set<OwnerLaunch>()
  const managedOwner = (id: string, metadataOwner = false): OwnerLaunch => {
    if (closed) throw new Error("credential owner admission is closed")
    const scope = createOwnerLaunch(config, id, metadataOwner)
    scopes.add(scope)
    void scope.exited.finally(() => scopes.delete(scope)).catch(() => {})
    return {
      ...scope,
      spawn(input) {
        if (closed) throw new Error("credential owner admission is closed")
        const child = scope.spawn(input)
        const entries = live.get(id) ?? new Set<OwnerLaunch>()
        live.set(id, entries)
        entries.add(scope)
        void scope.exited
          .finally(() => {
            entries.delete(scope)
            if (!entries.size) live.delete(id)
          })
          .catch(() => {})
        return child
      },
    }
  }
  const ownerLaunch: OwnerLaunchFactory = (id) => managedOwner(id)
  const validate = (id: string, path: string | null) => {
    if (path !== null && path !== join(config.root, id))
      throw new Error("credential directory authority mismatch")
  }
  const closeAdmission = () => {
    closed = true
    for (const scope of scopes) if (!metadata.has(scope)) scope.cancel()
  }
  return {
    ownerLaunch,
    closeAdmission,
    async provisionAccount({ id, configDir }) {
      if (closed) throw new Error("credential owner admission is closed")
      validate(id, configDir)
      await makeAnchoredRoot(config.root, 0o700)
      if (closed) throw new Error("credential owner admission is closed")
      if ((await operation(config, "provision", id, [])) !== 0)
        throw new Error("credential directory provision unavailable or retired")
      return configDir
    },
    async stop() {
      closeAdmission()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const settled = await Promise.race([
          Promise.allSettled([...scopes].map((scope) => scope.exited)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error("credential owner shutdown timed out; ownership remains uncertain"),
                ),
              config.shutdownDrainMs,
            )
          }),
        ])
        if (settled.some((result) => result.status === "rejected"))
          throw new Error("credential owner shutdown uncertain")
      } finally {
        clearTimeout(timer)
      }
    },
    async revokeDeletedAccount({ id, configDir }) {
      validate(id, configDir)
      for (const owner of live.get(id) ?? []) if (!metadata.has(owner)) owner.cancel()
      if (configDir !== null && (await operation(config, "revoke", id, [])) !== 0)
        throw new Error("credential directory revocation unavailable")
    },
    async cleanupDeletedAccount({ id, configDir }) {
      validate(id, configDir)
      if (configDir === null) return "not_applicable"
      const result = await operation(config, "cleanup", id, [
        String(config.cleanupMaximumEntries),
        String(config.cleanupMaximumDepth),
      ])
      return result === 0 ? "removed" : "deferred"
    },
    async withMetadataOwner(id, task) {
      let owner: OwnerLaunch
      try {
        owner = managedOwner(id, true)
      } catch {
        throw new UpstreamAdmissionRefused("credential metadata owner unavailable")
      }
      // Track the underlying scope by equality-independent cancellation ownership below.
      let child: ChildProcess
      try {
        child = owner.spawn({
          command: "/bin/cat",
          args: [],
          cwd: join(config.root, id),
          env: { CLAUDE_CONFIG_DIR: join(config.root, id) },
          signal: new AbortController().signal,
        }) as ChildProcess
      } catch {
        owner.cancel()
        throw new UpstreamAdmissionRefused("credential metadata owner unavailable")
      }
      const tracked = [...(live.get(id) ?? [])].find((scope) => scope.exited === owner.exited)
      if (tracked) metadata.add(tracked)
      const exited = new Promise<void>((resolve, reject) => {
        child.once("error", () => reject(new Error("credential metadata owner unavailable")))
        child.once("exit", (code, signal) => {
          if (signal || code !== 0) reject(new Error("credential metadata owner exit uncertain"))
          else resolve()
        })
      })
      void exited.catch(() => {})
      let admitted = false
      try {
        try {
          await owner.ready
          await owner.prepare()
          owner.assertReady()
          owner.activate()
          await owner.started
          admitted = true
        } catch {
          owner.cancel()
          throw new UpstreamAdmissionRefused("credential metadata owner unavailable")
        }
        return await task()
      } finally {
        owner.release()
        child.stdin?.end()
        try {
          if (admitted) {
            await confirmMetadataRetirement(exited, owner.exited)
          } else {
            await exited.catch(() => {})
            await owner.exited.catch(() => {})
          }
        } finally {
          if (tracked) metadata.delete(tracked)
        }
      }
    },
  }
}

async function confirmMetadataRetirement(childExit: Promise<void>, ownerExit: Promise<void>) {
  try {
    await childExit
    await ownerExit
  } catch {
    throw new UpstreamAdmissionRefused("credential metadata owner exit uncertain")
  }
}
