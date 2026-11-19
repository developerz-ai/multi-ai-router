import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ownedCredentialMetadataReader } from "../../../src/composition/credential-ownership"
import {
  type AccountOwnershipConfig,
  createAccountCliOwnership,
} from "../../../src/providers/claude-sdk/account-ownership"
import { CredentialOwnerLaunchFailed } from "../../../src/providers/claude-sdk/owner-helper"
import { createOwnerLaunch } from "../../../src/providers/claude-sdk/owner-launch"
import { CredentialMetadataOwnershipUnavailable } from "../../../src/providers/claude-sdk/ownership-errors"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"

/**
 * #447: a guardian that cannot be launched at all. The runtime returns a child with no pid and
 * null protocol pipes, then emits `error` on a later tick; unhandled, that event is an uncaught
 * exception and the router shuts down — every Account with it — and the scope's exit never
 * settles, so the `cli-owners` shutdown step times out. Both prod fingerprints are asserted here:
 * no uncaught exception, and a shutdown that returns.
 *
 * No real helper is needed (the point is its absence), so these run on every platform.
 */

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(overrides: Partial<AccountOwnershipConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "router-owner-launch-"))
  roots.push(root)
  const id = randomUUID()
  const configDir = join(root, id)
  await mkdir(configDir, { mode: 0o700 })
  const config: AccountOwnershipConfig = {
    root,
    helperPath: join(root, "no-such-helper"),
    maximumOwners: 2,
    termGraceMs: 30,
    pollMs: 5,
    maximumChildren: 10,
    admissionTimeoutMs: 1000,
    cleanupMaximumEntries: 100,
    cleanupMaximumDepth: 8,
    operationTimeoutMs: 1000,
    shutdownDrainMs: 1000,
    ...overrides,
  }
  return { root, id, configDir, config }
}

/** Runs `body`, then waits out the runtime's deferred `error` event, collecting what escaped. */
async function uncaughtDuring(body: () => Promise<void>): Promise<unknown[]> {
  const escaped: unknown[] = []
  const listener = (error: unknown) => escaped.push(error)
  process.on("uncaughtException", listener)
  try {
    await body()
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    process.off("uncaughtException", listener)
  }
  return escaped
}

const spawnInput = (configDir: string) => ({
  command: "/bin/cat",
  args: [],
  cwd: configDir,
  env: { CLAUDE_CONFIG_DIR: configDir },
  signal: new AbortController().signal,
})

describe("a guardian that cannot be launched", () => {
  test("a missing helper is a named failure of the launch, never an uncaught exception", async () => {
    const { config, configDir, id } = await fixture()
    const scope = createOwnerLaunch(config, id)
    let thrown: unknown
    const escaped = await uncaughtDuring(async () => {
      try {
        scope.spawn(spawnInput(configDir))
      } catch (error) {
        thrown = error
      }
    })

    expect(escaped).toEqual([])
    expect(thrown).toBeInstanceOf(CredentialOwnerLaunchFailed)
    expect(thrown).toMatchObject({ reason: "helper_unavailable", path: config.helperPath })
    // Nothing was spawned, so there is no exit to be uncertain about.
    await expect(scope.exited).resolves.toBeUndefined()
    await expect(scope.ready).rejects.toThrow("credential owner cancelled")
  })

  test("a missing Account directory is told apart from a missing helper", async () => {
    // The runtime reports a missing working directory as ENOENT on the *helper's* path.
    const { config, configDir, id } = await fixture({ helperPath: process.execPath })
    await rm(configDir, { recursive: true })
    const scope = createOwnerLaunch(config, id)
    let thrown: unknown
    const escaped = await uncaughtDuring(async () => {
      try {
        scope.spawn(spawnInput(configDir))
      } catch (error) {
        thrown = error
      }
    })

    expect(escaped).toEqual([])
    expect(thrown).toMatchObject({ reason: "directory_missing", path: configDir })
    await expect(scope.exited).resolves.toBeUndefined()
  })

  test("a metadata read under it is refused with the cause, and the next Account is unaffected", async () => {
    const { config, root, id } = await fixture()
    const owners = createAccountCliOwnership(config)
    const reader = ownedCredentialMetadataReader(
      { read: async () => ({ hasTokens: true }) as never },
      owners,
      root,
    )
    let refusal: unknown
    const escaped = await uncaughtDuring(async () => {
      refusal = await reader.read(join(root, id)).catch((error: unknown) => error)
    })

    expect(escaped).toEqual([])
    expect(refusal).toBeInstanceOf(CredentialMetadataOwnershipUnavailable)
    expect((refusal as CredentialMetadataOwnershipUnavailable).launchFailure).toMatchObject({
      reason: "helper_unavailable",
      path: config.helperPath,
    })
    // The underlying verdict is still the admission refusal every other caller handles.
    await expect(owners.withMetadataOwner(id, async () => 1)).rejects.toBeInstanceOf(
      UpstreamAdmissionRefused,
    )
  })
})

describe("the cli-owners shutdown step", () => {
  test("returns at once when no owner was ever spawned", async () => {
    const { config } = await fixture({ shutdownDrainMs: 200 })
    const owners = createAccountCliOwnership(config)
    await expect(owners.stop()).resolves.toBeUndefined()
  })

  test("returns at once after launches that failed — they left no owner to wait for", async () => {
    const { config, id } = await fixture({ shutdownDrainMs: 200 })
    const owners = createAccountCliOwnership(config)
    await owners.withMetadataOwner(id, async () => 1).catch(() => {})
    await owners.withMetadataOwner(id, async () => 1).catch(() => {})

    const startedAt = performance.now()
    await expect(owners.stop()).resolves.toBeUndefined()
    expect(performance.now() - startedAt).toBeLessThan(150)
  })

  test("returns after an inference scope whose spawn failed", async () => {
    const { config, configDir, id } = await fixture({ shutdownDrainMs: 200 })
    const owners = createAccountCliOwnership(config)
    const scope = owners.ownerLaunch(id)
    expect(() => scope.spawn(spawnInput(configDir))).toThrow(CredentialOwnerLaunchFailed)
    await expect(owners.stop()).resolves.toBeUndefined()
  })
})
