import { accessSync, constants, existsSync, statSync } from "node:fs"

/** Whether the credential-owner helper at `path` is a file this process may execute. */
export function ownerHelperUsable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    // Any refusal to stat or execute is the answer, not a failure of the question.
    return false
  }
}

/**
 * Why no guardian process came to exist. The first two are read off the filesystem at the moment
 * of the failure and stay true until someone acts; `spawn_failed` is everything else (a spent
 * process table, no memory) and says nothing lasting about the Account.
 */
export type OwnerLaunchFailureReason = "helper_unavailable" | "directory_missing" | "spawn_failed"

/** The guardian was never spawned, so nothing owns the directory and there is no exit to await. */
export class CredentialOwnerLaunchFailed extends Error {
  constructor(
    readonly reason: OwnerLaunchFailureReason,
    /** The path the reason is about: the helper, or the Account directory it would run in. */
    readonly path: string,
  ) {
    super(`credential owner launch failed: ${reason} (${path})`)
    this.name = "CredentialOwnerLaunchFailed"
  }
}

/**
 * Names the cause of a failed guardian spawn. Needed because the runtime does not: a missing
 * working directory is reported as `ENOENT` on the *helper's* path, indistinguishable from a
 * missing helper (#447).
 */
export function diagnoseOwnerLaunchFailure(
  helperPath: string,
  cwd: string,
): CredentialOwnerLaunchFailed {
  if (!ownerHelperUsable(helperPath))
    return new CredentialOwnerLaunchFailed("helper_unavailable", helperPath)
  if (!existsSync(cwd)) return new CredentialOwnerLaunchFailed("directory_missing", cwd)
  return new CredentialOwnerLaunchFailed("spawn_failed", helperPath)
}

/**
 * The boot rule: a deployment holding Accounts that need the helper does not start without it.
 * Pure, so the matrix is a unit test; `boot.ts` supplies the filesystem and the account count.
 */
export function ownerHelperBootProblem(input: {
  readonly helperPath: string
  readonly usable: boolean
  /** Accounts whose provider keeps a CLI-managed credential directory, disabled ones excluded. */
  readonly accountsNeedingHelper: number
}): string | null {
  if (input.usable || input.accountsNeedingHelper === 0) return null
  return [
    "Invalid environment configuration:",
    `  CLAUDE_OWNERSHIP_HELPER_PATH: ${input.helperPath} does not exist or is not an executable file,`,
    `  and ${input.accountsNeedingHelper} Claude subscription account(s) cannot be served without it.`,
    "  Build it with bin/build-cli-owner, or point the variable at the helper the image ships",
    "  (/usr/local/libexec/router-cli-owner). See docs/idea/09-deployment.md.",
  ].join("\n")
}

/**
 * Whether a guardian that closed before `R` provably left no owner marker, so nothing owns the
 * directory and the exit is certain. Read only with `R` absent; `close` follows the status pipe's
 * last byte, so an absent `R` was never written.
 *
 * - `73` (deleted) and `75` (capacity, a lock or a generation refused) are returned only before
 *   `write_marker`, or from `retire_owner`, which follows `R`.
 * - Dying *of* the two signals this module sends means their handlers were not installed yet, and
 *   `config-owner.c` installs them before it writes the marker.
 *
 * Everything else stays uncertain: `70` covers a marker half-written, and a `SIGKILL` can land
 * between the marker and `R`. Without this an Account at its owner ceiling, or one client hanging
 * up while the guardian started, was refused until the process restarted.
 */
export function neverRegistered(code: number | null, signal: NodeJS.Signals | null): boolean {
  return code === 73 || code === 75 || signal === "SIGTERM" || signal === "SIGUSR2"
}
