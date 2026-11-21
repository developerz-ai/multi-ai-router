import { resolve } from "node:path"
import {
  type CredentialRefreshLock,
  createAccountReplicaLeaseRepository,
} from "@multi-ai-router/db"
import {
  createCredentialFreshness,
  createCredentialMetadataReader,
  createSdkConcurrency,
} from "../providers"
import { createAccountCliOwnership } from "../providers/claude-sdk/account-ownership"
import { createAccountConfigDirs, WORKSPACE_DIR } from "../providers/claude-sdk/config-dir"
import { createReplicaLeaseManager } from "../providers/claude-sdk/replica-lease"
import {
  createLocalReplicaStorage,
  createReplicaStorage,
  createStorageAttachmentHelper,
  type ExclusiveStorageAttachment,
} from "../providers/claude-sdk/replica-storage"
import { createSessionCarrier } from "../providers/claude-sdk/session-carry"
import { createSdkTranscripts } from "../providers/claude-sdk/transcripts"
import { ownedCredentialMetadataReader } from "./credential-ownership"
import type { RuntimeDeps } from "./runtime-types"
export function createCliResources(
  deps: RuntimeDeps,
  now: () => Date,
  // The cross-replica half of the refresh-window gate, from the pool the OAuth refresher already
  // holds; the same reason it is a parameter and not a second pool here.
  refreshLock: Pick<CredentialRefreshLock, "tryAcquire">,
  // Supplied by the storage integration, never inferred from a configured path or TTL.
  attachment?: ExclusiveStorageAttachment,
) {
  const { env, logger } = deps
  // The replica's shared `claude` subprocess ceiling, constructed here
  // rather than beside the invoker because it is shared: the dispatch path and the console's "Test
  // now" probe spawn the same ~245 MB process, so they must count against the same budget. A second
  // instance sized the same would bound twice what the operator configured (`concurrency.ts`).
  const sdkConcurrency = createSdkConcurrency({
    global: env.claudeSdkMaxConcurrency,
    perAccount: env.claudeSdkMaxConcurrencyPerAccount,
  })

  // One isolated CLAUDE_CONFIG_DIR per subscription account, and one view of the volume they live
  // on. Built here rather than beside the admin plane because it has a second reader: the
  // scheduler's reaper removes what a crash between provisioning and the insert left behind, and a
  // reaper rooted somewhere other than the provisioner would sweep the wrong directory or nothing
  // at all (`scheduler/tasks/config-dir-reap.ts`).
  const rawConfigDirs = createAccountConfigDirs({ root: env.claudeConfigRoot })
  const ownershipConfig = {
    ...env.cliOwnership,
    shutdownDrainMs: env.background.shutdownDrainMs,
    root: rawConfigDirs.root,
    helperPath: resolve(env.cliOwnership.helperPath),
  }
  const leaseConfig = env.cliOwnership.replicaLease
  const replicaRepository = createAccountReplicaLeaseRepository(deps.database)
  const injectedAttachment = attachment ?? deps.storageAttachment
  const storageAuthority =
    injectedAttachment ??
    (leaseConfig.attachmentHelperPath
      ? createStorageAttachmentHelper(
          leaseConfig.attachmentHelperPath,
          rawConfigDirs.root,
          env.cliOwnership.operationTimeoutMs,
        )
      : undefined)
  const drains = {
    retireLocalOwners: async (id: string) => {
      await localOwnership.retireLocalOwners?.(id)
      await injectedAttachment?.retireLocalOwners(id)
    },
    drainMetadata: async (id: string) => {
      await localOwnership.drainMetadata?.(id)
      await injectedAttachment?.drainMetadata(id)
    },
  }
  const localStorage =
    leaseConfig.storageAttachment === "local"
      ? createLocalReplicaStorage(rawConfigDirs.root, ownershipConfig.helperPath, drains)
      : undefined
  const replicaStorage =
    localStorage ??
    createReplicaStorage(
      rawConfigDirs.root,
      leaseConfig.storageIdentity ?? "unassigned-local-storage",
      {
        // Only the external authority's receipt proves cross-node exclusion, not its configured path.
        confirm: (token, identity) =>
          leaseConfig.storageAttachment === "exclusive-reattach" && storageAuthority
            ? storageAuthority.confirm(token, identity)
            : Promise.resolve(false),
        ...drains,
        provisionNew: async (token, identity) => {
          if (!storageAuthority?.provisionNew)
            throw new Error("new account storage authority unavailable")
          await storageAuthority.provisionNew(token, identity)
        },
      },
    )
  const replicaLease = createReplicaLeaseManager(replicaRepository, replicaStorage, leaseConfig)
  const localOwnership = createAccountCliOwnership({
    ...ownershipConfig,
    generation: (id) => replicaLease.handle(id),
  })
  const ownership: typeof localOwnership = {
    ...localOwnership,
    ownerLaunch(id) {
      const generation = replicaLease.handle(id)
      const owner = localOwnership.ownerLaunch(id)
      const cancel = () => owner.cancel()
      generation.signal.addEventListener("abort", cancel, { once: true })
      void owner.exited
        .finally(() => generation.signal.removeEventListener("abort", cancel))
        .catch(() => {})
      return {
        ...owner,
        spawn(input) {
          generation.assert()
          return owner.spawn(input)
        },
        async prepare() {
          generation.assert()
          await owner.prepare()
          generation.assert()
        },
        assertReady() {
          generation.assert()
          owner.assertReady()
        },
        activate() {
          generation.assert()
          owner.activate()
        },
      }
    },
    async withMetadataOwner(id, task) {
      const generation = replicaLease.handle(id)
      return localOwnership.withMetadataOwner(id, async () => {
        generation.assert()
        const result = await task()
        generation.assert()
        return result
      })
    },
    async provisionAccount(input) {
      // First allocation acquires its lease and persistent storage before native provisioning.
      const handle = await replicaLease.ensure(input.id, true)
      if (!handle) throw new Error("new account storage ownership unavailable")
      handle.assert()
      const path = await localOwnership.provisionAccount(input)
      handle.assert()
      return path
    },
    revokeDeletedAccount(input) {
      replicaLease.handle(input.id).assert()
      return localOwnership.revokeDeletedAccount(input)
    },
    cleanupDeletedAccount(input) {
      replicaLease.handle(input.id).assert()
      return localOwnership.cleanupDeletedAccount(input)
    },
    isRevoked: (id) => !replicaLease.eligible(id) || (localOwnership.isRevoked?.(id) ?? false),
    closeAdmission() {
      replicaLease.closeAdmission()
      localOwnership.closeAdmission()
    },
    async stop() {
      await replicaLease.stop(() => localOwnership.stop())
      await localStorage?.stop()
    },
  }
  const configDirs = {
    ...rawConfigDirs,
    provision: (id: string) =>
      ownership.provisionAccount({ id, configDir: rawConfigDirs.pathFor(id) }),
    // The router's own infrastructure on the volume — the ownership state and the neutral
    // inference workspace (`options.ts`, #296) — is not an account entry and never a "foreign"
    // one: neither the reaper nor an operator survey has anything to make of them.
    list: async () =>
      (await rawConfigDirs.list()).filter(
        (entry) =>
          entry.name !== ".ownership" &&
          entry.name !== WORKSPACE_DIR &&
          entry.name !== ".replica-storage-identity" &&
          entry.name !== ".replica-local-lock",
      ),
    remove: async (id: string) => {
      const account = { id, configDir: rawConfigDirs.pathFor(id) }
      await ownership.revokeDeletedAccount(account)
      const outcome = await ownership.cleanupDeletedAccount(account)
      if (outcome === "deferred")
        logger.info("credential directory cleanup deferred", { accountId: id })
      return outcome
    },
  }
  // The transcripts the CLI leaves under those directories, over the validated root: the sweep
  // that removes them is the retention half of the same volume (`scheduler/tasks/sdk-transcript-sweep.ts`).
  const transcripts = createSdkTranscripts({
    root: configDirs.root,
    withAccountOwner: ownership.withMetadataOwner,
  })
  // The other direction over the same volume: a bound conversation's transcript carried to the
  // Account a failover lands on, under both Accounts' owner holds (`session-carry.ts`).
  const sessionCarrier = env.claudeSdkSessionCarry.enabled
    ? createSessionCarrier({
        root: configDirs.root,
        maxBytes: env.claudeSdkSessionCarry.maxBytes,
        withAccountOwner: ownership.withMetadataOwner,
      })
    : undefined
  // Only one `claude` subprocess may cross an Account's token-refresh moment, because the refresh
  // token rotates and a second spender gets rejected — after which the losing CLI blanks the
  // credential file and the Account needs an interactive re-login
  // (`providers/claude-sdk/credential-freshness.ts`, docs/idea/11-anthropic-agent-sdk.md §3).
  // Shared by every spawn site for the same reason `sdkConcurrency` is: a gate only some callers
  // honour is not a gate.
  const credentialReader = ownedCredentialMetadataReader(
    createCredentialMetadataReader(),
    ownership,
    configDirs.root,
  )
  const credentialFreshness = createCredentialFreshness({
    reader: credentialReader,
    configDirs,
    skewMs: env.claudeSdkCredentialRefreshSkewSeconds * 1_000,
    coldMarginMs: env.claudeSdkCredentialColdMarginSeconds * 1_000,
    maxWaitMs: env.claudeSdkCredentialRefreshWaitMs,
    pollMs: env.claudeSdkCredentialRefreshPollMs,
    now,
    refreshLock,
    logger,
  })

  return {
    replicaLease,
    replicaStorage,
    replicaRepository,
    sdkConcurrency,
    rawConfigDirs,
    ownershipConfig,
    ownership,
    configDirs,
    transcripts,
    sessionCarrier,
    credentialReader,
    credentialFreshness,
  }
}
