import { type ChildProcess, spawn } from "node:child_process"
import { join } from "node:path"
import { UpstreamAdmissionRefused } from "../upstream-admission"
import type { AccountCliOwnership, AccountOwnershipConfig } from "./account-ownership-types"
import { WORKSPACE_DIR } from "./config-dir"
import { makeAnchoredDirectory, makeAnchoredRoot } from "./config-dir-fs"
import type { OwnerLaunchFactory } from "./owned-query"
import { CredentialOwnerLaunchFailed } from "./owner-helper"
import { createOwnerLaunch, type OwnerLaunch } from "./owner-launch"
import { type OwnershipOperationDependencies, ownershipOperation } from "./ownership-operation"

export type { AccountCliOwnership, AccountOwnershipConfig } from "./account-ownership-types"
export function createAccountCliOwnership(
  config: AccountOwnershipConfig,
  operationDependencies?: OwnershipOperationDependencies,
): AccountCliOwnership {
  const operations = new Set<Promise<unknown>>()
  const callbacks = new Map<string, Set<Promise<unknown>>>()
  const failedRetirements = new Set<string>()
  let uncertain = false
  const operation = async (
    config: AccountOwnershipConfig,
    mode: string,
    id: string,
    args: string[],
  ) => {
    if (failedRetirements.has(id)) throw new Error("credential owner retirement uncertain")
    const generation = config.generation?.(id)
    generation?.assert()
    const result = ownershipOperation(config, mode, id, args, {
      schedule:
        operationDependencies?.schedule ??
        ((callback, delay) => {
          const timer = setTimeout(callback, delay)
          return () => clearTimeout(timer)
        }),
      spawn(command, argv) {
        generation?.assert()
        const child = operationDependencies
          ? operationDependencies.spawn(command, argv)
          : spawn(command, argv, { stdio: "ignore" })
        const cancel = () => {
          child.kill("SIGKILL")
        }
        generation?.signal.addEventListener("abort", cancel, { once: true })
        const retired = new Promise<void>((resolve, reject) => {
          child.once("exit", () => resolve())
          child.once("error", () => {
            uncertain = true
            failedRetirements.add(id)
            reject(new Error("ownership operation exit uncertain"))
          })
        })
        operations.add(retired)
        const pending = callbacks.get(id) ?? new Set<Promise<unknown>>()
        callbacks.set(id, pending)
        pending.add(retired)
        void retired
          .finally(() => {
            operations.delete(retired)
            pending.delete(retired)
            if (!pending.size) callbacks.delete(id)
            generation?.signal.removeEventListener("abort", cancel)
          })
          .catch(() => {})
        if (generation?.signal.aborted) cancel()
        return child
      },
    })
    const code = await result
    generation?.assert()
    return code
  }
  let closed = false
  const live = new Map<string, Set<OwnerLaunch>>()
  const scopes = new Set<OwnerLaunch>()
  const metadata = new Set<OwnerLaunch>()
  const revoked = new Set<string>()
  const managedOwner = (id: string, metadataOwner = false): OwnerLaunch => {
    if (closed) throw new Error("credential owner admission is closed")
    if (failedRetirements.has(id)) throw new Error("credential owner retirement uncertain")
    const generation = config.generation?.(id)
    generation?.assert()
    const scope = createOwnerLaunch(config, id, metadataOwner, generation)
    scopes.add(scope)
    void scope.exited.then(
      () => scopes.delete(scope),
      () => {
        uncertain = true
        failedRetirements.add(id)
      },
    )
    return {
      ...scope,
      spawn(input) {
        if (closed) throw new Error("credential owner admission is closed")
        const child = scope.spawn(input)
        const entries = live.get(id) ?? new Set<OwnerLaunch>()
        live.set(id, entries)
        entries.add(scope)
        void scope.exited
          .then(() => {
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
    async retireLocalOwners(id) {
      if (failedRetirements.has(id)) throw new Error("credential owner retirement uncertain")
      const owners = [...(live.get(id) ?? [])]
      for (const owner of owners) if (!metadata.has(owner)) owner.cancel()
      await Promise.all(owners.filter((owner) => !metadata.has(owner)).map((owner) => owner.exited))
    },
    async drainMetadata(id) {
      await Promise.all([...(callbacks.get(id) ?? [])])
      await Promise.all(
        [...(live.get(id) ?? [])]
          .filter((owner) => metadata.has(owner))
          .map((owner) => owner.exited),
      )
      if (failedRetirements.has(id)) throw new Error("credential metadata retirement uncertain")
    },
    async provisionAccount({ id, configDir }) {
      if (closed) throw new Error("credential owner admission is closed")
      if (failedRetirements.has(id)) throw new Error("credential owner retirement uncertain")
      const generation = config.generation?.(id)
      generation?.assert()
      validate(id, configDir)
      await makeAnchoredRoot(config.root, 0o700)
      generation?.assert()
      // The neutral inference workspace, beside the account directories (`options.ts`, #296):
      // anchored, before any subprocess needs it as its working directory.
      await makeAnchoredDirectory(join(config.root, WORKSPACE_DIR), 0o700)
      generation?.assert()
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
          Promise.allSettled(
            [...scopes]
              .map((scope) => scope.exited)
              .concat(
                [...operations].map(async (operation) => {
                  await operation
                }),
              ),
          ),
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
        if (uncertain || settled.some((result) => result.status === "rejected"))
          throw new Error("credential owner shutdown uncertain")
      } finally {
        clearTimeout(timer)
      }
    },
    isRevoked: (id) => revoked.has(id) || failedRetirements.has(id),
    async revokeDeletedAccount({ id, configDir }) {
      // No directory, no replica lease: asserting one failed the delete of an HTTP Account.
      if (configDir !== null) config.generation?.(id).assert()
      validate(id, configDir)
      // Before the operation: a revoke that fails half-way still must not keep serving a cache.
      revoked.add(id)
      for (const owner of live.get(id) ?? []) if (!metadata.has(owner)) owner.cancel()
      if (configDir !== null && (await operation(config, "revoke", id, [])) !== 0)
        throw new Error("credential directory revocation unavailable")
    },
    async cleanupDeletedAccount({ id, configDir }) {
      if (configDir === null) return "not_applicable"
      config.generation?.(id).assert()
      validate(id, configDir)
      const result = await operation(config, "cleanup", id, [
        String(config.cleanupMaximumEntries),
        String(config.cleanupMaximumDepth),
      ])
      return result === 0 ? "removed" : "deferred"
    },
    async withMetadataOwner(id, task) {
      const generation = config.generation?.(id)
      generation?.assert()
      let owner: OwnerLaunch
      try {
        owner = managedOwner(id, true)
      } catch {
        throw new UpstreamAdmissionRefused("credential metadata owner unavailable")
      }
      let child: ChildProcess
      try {
        child = owner.spawn({
          command: "/bin/cat",
          args: [],
          cwd: join(config.root, id),
          env: { CLAUDE_CONFIG_DIR: join(config.root, id) },
          signal: new AbortController().signal,
        }) as ChildProcess
      } catch (error) {
        owner.cancel()
        // A guardian that never launched keeps its cause: the caller may act on the Account.
        throw new UpstreamAdmissionRefused(
          "credential metadata owner unavailable",
          error instanceof CredentialOwnerLaunchFailed ? { cause: error } : undefined,
        )
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
        generation?.assert()
        const work = Promise.resolve().then(task)
        operations.add(work)
        const pending = callbacks.get(id) ?? new Set<Promise<unknown>>()
        callbacks.set(id, pending)
        pending.add(work)
        try {
          const result = await work
          generation?.assert()
          return result
        } finally {
          operations.delete(work)
          pending.delete(work)
          if (!pending.size) callbacks.delete(id)
        }
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
  // Observe both: child exit can precede recording the guardian's uncertain retirement.
  const results = await Promise.allSettled([childExit, ownerExit])
  if (results.some((result) => result.status === "rejected")) {
    throw new UpstreamAdmissionRefused("credential metadata owner exit uncertain")
  }
}
