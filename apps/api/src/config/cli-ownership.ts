import { isAbsolute } from "node:path"
import { z } from "zod"
import { EnvValidationError } from "./env-error"
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
  CLAUDE_OWNERSHIP_LEASE_TTL_MS: atLeastOne
    .refine((value) => value >= 100 && value <= 300_000, "must be between 100 and 300000")
    .optional(),
  CLAUDE_OWNERSHIP_HEARTBEAT_MS: bounded(100_000),
  CLAUDE_OWNERSHIP_SAFETY_MARGIN_MS: bounded(60_000),
  CLAUDE_OWNERSHIP_RECONCILE_BATCH_SIZE: bounded(1024),
  CLAUDE_OWNERSHIP_STORAGE_IDENTITY: nonEmpty
    .refine((value) => value.length <= 256, "must be at most 256 characters")
    .optional(),
  CLAUDE_OWNERSHIP_STORAGE_ATTACHMENT: z.enum(["local", "exclusive-reattach"]).optional(),
  CLAUDE_OWNERSHIP_ATTACHMENT_HELPER_PATH: nonEmpty
    .refine(isAbsolute, "must be an absolute path")
    .optional(),
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
  CLAUDE_OWNERSHIP_LEASE_TTL_MS?: number
  CLAUDE_OWNERSHIP_HEARTBEAT_MS?: number
  CLAUDE_OWNERSHIP_SAFETY_MARGIN_MS?: number
  CLAUDE_OWNERSHIP_RECONCILE_BATCH_SIZE?: number
  CLAUDE_OWNERSHIP_STORAGE_IDENTITY?: string
  CLAUDE_OWNERSHIP_STORAGE_ATTACHMENT?: "local" | "exclusive-reattach"
  CLAUDE_OWNERSHIP_ATTACHMENT_HELPER_PATH?: string
}) {
  const ttlMs = raw.CLAUDE_OWNERSHIP_LEASE_TTL_MS ?? 30_000
  const heartbeatMs = raw.CLAUDE_OWNERSHIP_HEARTBEAT_MS ?? 5000
  const safetyMarginMs = raw.CLAUDE_OWNERSHIP_SAFETY_MARGIN_MS ?? 2000
  const storageAttachment = raw.CLAUDE_OWNERSHIP_STORAGE_ATTACHMENT ?? "local"
  const storageIdentity = raw.CLAUDE_OWNERSHIP_STORAGE_IDENTITY ?? null
  const attachmentHelperPath = raw.CLAUDE_OWNERSHIP_ATTACHMENT_HELPER_PATH ?? null
  if (heartbeatMs * 3 + safetyMarginMs >= ttlMs) {
    const variables = [
      "CLAUDE_OWNERSHIP_LEASE_TTL_MS",
      "CLAUDE_OWNERSHIP_HEARTBEAT_MS",
      "CLAUDE_OWNERSHIP_SAFETY_MARGIN_MS",
    ]
    throw new EnvValidationError(
      `${variables.join(", ")}: TTL must exceed three heartbeats plus the safety margin`,
      variables,
    )
  }
  if (
    storageAttachment === "exclusive-reattach" &&
    (storageIdentity === null || attachmentHelperPath === null)
  ) {
    const variables = [
      "CLAUDE_OWNERSHIP_STORAGE_IDENTITY",
      "CLAUDE_OWNERSHIP_ATTACHMENT_HELPER_PATH",
    ]
    throw new EnvValidationError(
      `${variables.join(", ")}: exclusive-reattach requires both; shared RWX storage is not fencing`,
      variables,
    )
  }
  if (storageAttachment === "local" && attachmentHelperPath !== null) {
    throw new EnvValidationError(
      "CLAUDE_OWNERSHIP_ATTACHMENT_HELPER_PATH requires CLAUDE_OWNERSHIP_STORAGE_ATTACHMENT=exclusive-reattach",
      ["CLAUDE_OWNERSHIP_ATTACHMENT_HELPER_PATH", "CLAUDE_OWNERSHIP_STORAGE_ATTACHMENT"],
    )
  }
  if (storageAttachment === "local" && storageIdentity !== null)
    throw new EnvValidationError(
      "CLAUDE_OWNERSHIP_STORAGE_IDENTITY requires exclusive-reattach; local identity is persistent and generated",
      ["CLAUDE_OWNERSHIP_STORAGE_IDENTITY", "CLAUDE_OWNERSHIP_STORAGE_ATTACHMENT"],
    )
  return {
    cliOwnership: {
      replicaLease: {
        ttlMs,
        heartbeatMs,
        safetyMarginMs,
        batchSize: raw.CLAUDE_OWNERSHIP_RECONCILE_BATCH_SIZE ?? 64,
        // Local mode never authorizes cross-node takeover. Configuration is not attachment proof.
        storageAttachment,
        storageIdentity,
        attachmentHelperPath,
      },
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
