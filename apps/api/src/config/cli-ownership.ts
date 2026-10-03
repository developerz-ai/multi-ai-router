import { atLeastOne, nonEmpty } from "./fields"

const bounded = (maximum: number) =>
  atLeastOne.refine((value) => value <= maximum, `must be at most ${maximum}`).optional()

export const CLI_OWNERSHIP_ENV_FIELDS = {
  CLAUDE_OWNERSHIP_HELPER_PATH: nonEmpty.optional(),
  CLAUDE_OWNERSHIP_MAX_OWNERS_PER_ACCOUNT: bounded(4096),
  CLAUDE_OWNERSHIP_TERM_GRACE_MS: bounded(60_000),
  CLAUDE_OWNERSHIP_POLL_MS: bounded(1000),
  CLAUDE_OWNERSHIP_MAX_CHILDREN: bounded(65_536),
  CLAUDE_OWNERSHIP_ADMISSION_TIMEOUT_MS: bounded(60_000),
  CLAUDE_OWNERSHIP_CLEANUP_MAX_ENTRIES: bounded(10_000_000),
  CLAUDE_OWNERSHIP_CLEANUP_MAX_DEPTH: bounded(256),
  CLAUDE_OWNERSHIP_OPERATION_TIMEOUT_MS: bounded(60_000),
}

export function readCliOwnershipEnv(raw: {
  CLAUDE_OWNERSHIP_HELPER_PATH?: string
  CLAUDE_OWNERSHIP_MAX_OWNERS_PER_ACCOUNT?: number
  CLAUDE_OWNERSHIP_TERM_GRACE_MS?: number
  CLAUDE_OWNERSHIP_POLL_MS?: number
  CLAUDE_OWNERSHIP_MAX_CHILDREN?: number
  CLAUDE_OWNERSHIP_ADMISSION_TIMEOUT_MS?: number
  CLAUDE_OWNERSHIP_CLEANUP_MAX_ENTRIES?: number
  CLAUDE_OWNERSHIP_CLEANUP_MAX_DEPTH?: number
  CLAUDE_OWNERSHIP_OPERATION_TIMEOUT_MS?: number
}) {
  return {
    cliOwnership: {
      helperPath: raw.CLAUDE_OWNERSHIP_HELPER_PATH ?? "native/config-owner",
      maximumOwners: raw.CLAUDE_OWNERSHIP_MAX_OWNERS_PER_ACCOUNT ?? 64,
      termGraceMs: raw.CLAUDE_OWNERSHIP_TERM_GRACE_MS ?? 1000,
      pollMs: raw.CLAUDE_OWNERSHIP_POLL_MS ?? 25,
      maximumChildren: raw.CLAUDE_OWNERSHIP_MAX_CHILDREN ?? 256,
      admissionTimeoutMs: raw.CLAUDE_OWNERSHIP_ADMISSION_TIMEOUT_MS ?? 10_000,
      cleanupMaximumEntries: raw.CLAUDE_OWNERSHIP_CLEANUP_MAX_ENTRIES ?? 100_000,
      cleanupMaximumDepth: raw.CLAUDE_OWNERSHIP_CLEANUP_MAX_DEPTH ?? 64,
      operationTimeoutMs: raw.CLAUDE_OWNERSHIP_OPERATION_TIMEOUT_MS ?? 15_000,
    },
  }
}
