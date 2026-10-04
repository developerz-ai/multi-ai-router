import { resolve } from "node:path"
import {
  createCredentialFreshness,
  createCredentialMetadataReader,
  createSdkConcurrency,
} from "../providers"
import { createAccountCliOwnership } from "../providers/claude-sdk/account-ownership"
import { createAccountConfigDirs } from "../providers/claude-sdk/config-dir"
import { createSdkTranscripts } from "../providers/claude-sdk/transcripts"
import { ownedCredentialMetadataReader } from "./credential-ownership"

import type { RuntimeDeps } from "./runtime-types"
export function createCliResources(deps: RuntimeDeps, now: () => Date) {
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
  const ownership = createAccountCliOwnership(ownershipConfig)
  const configDirs = {
    ...rawConfigDirs,
    provision: (id: string) =>
      ownership.provisionAccount({ id, configDir: rawConfigDirs.pathFor(id) }),
    list: async () => (await rawConfigDirs.list()).filter((entry) => entry.name !== ".ownership"),
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
    logger,
  })

  return {
    sdkConcurrency,
    rawConfigDirs,
    ownershipConfig,
    ownership,
    configDirs,
    transcripts,
    credentialFreshness,
  }
}
