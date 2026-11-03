import { z } from "../../../apps/api/node_modules/zod"

const metadata = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) })

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk"
const SDK_CWD = "apps/api"
const REGISTRY_URL = `https://registry.npmjs.org/${SDK_PACKAGE}/latest`

export type SdkVersionDeps = {
  /** Resolves the version currently installed in the API workspace. */
  installedVersion: () => Promise<string>
  /** Resolves the version published to the npm registry. */
  latestVersion: () => Promise<string>
  /** Installs the given dependency spec into the API workspace. */
  install: (spec: string) => Promise<void>
}

/**
 * Builds the install spec for the SDK from a selected version.
 *
 * The spec names the exact version: the manifest pins the SDK, and a range
 * operator here would let `bun add` rewrite `apps/api/package.json` into a
 * floating range that drifts away from the lockfile-pinned binary.
 */
export function sdkInstallSpec(version: string): string {
  const parsed = metadata.parse({ version })
  return `${SDK_PACKAGE}@${parsed.version}`
}

async function readInstalledVersion(): Promise<string> {
  return metadata.parse(
    await Bun.file(`${SDK_CWD}/node_modules/${SDK_PACKAGE}/package.json`).json(),
  ).version
}

async function readLatestVersion(): Promise<string> {
  const response = await fetch(REGISTRY_URL)
  if (!response.ok) throw new Error(`SDK registry returned ${response.status}`)
  return metadata.parse(await response.json()).version
}

/**
 * Builds the `bun add` command that records the dependency in the manifest.
 *
 * `--exact` is what makes the manifest exact: without it `bun add` saves the
 * `^` range its default save semantics imply, and the pin this repo keeps
 * would quietly become a floating range.
 */
export function sdkInstallCommand(spec: string): string[] {
  return ["bun", "add", "--exact", "--cwd", SDK_CWD, spec]
}

async function runInstall(spec: string): Promise<void> {
  const command = Bun.spawn(sdkInstallCommand(spec), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await command.exited) !== 0) throw new Error("SDK update failed")
}

export const defaultSdkVersionDeps: SdkVersionDeps = {
  installedVersion: readInstalledVersion,
  latestVersion: readLatestVersion,
  install: runInstall,
}

export async function sdkVersion(
  update: boolean,
  deps: SdkVersionDeps = defaultSdkVersionDeps,
): Promise<void> {
  const installed = await deps.installedVersion()
  const latest = await deps.latestVersion()
  process.stdout.write(`${JSON.stringify({ installed, latest })}\n`)
  if (!update || installed === latest) return
  await deps.install(sdkInstallSpec(latest))
  process.stderr.write(
    "SDK manifest and lockfile updated. Rerun bin/claude-trace scenarios and bin/check.\n",
  )
}
