import { createHash } from "node:crypto"
import type { UsageContribution } from "../schema/usage-contributions"
import type { NewUsageRecordRow } from "../schema/usage-records"
import type { UsageRequestTerminalInsert } from "../schema/usage-request-terminals"

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "ingestedAt")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}
export function usagePayloadHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")
}
export function attemptContribution(row: NewUsageRecordRow, fallback: Date): UsageContribution {
  return {
    apiKeyId: row.apiKeyId ?? null,
    accountId: row.accountId ?? null,
    poolId: row.poolId ?? null,
    model: row.model ?? null,
    correlationId: row.correlationId,
    eventAt: (row.createdAt ?? fallback).toISOString(),
    attempts: 1,
    requests: 0,
    errors: row.outcome === "success" ? 0 : 1,
    tokensIn: row.tokensIn ?? 0,
    tokensOut: row.tokensOut ?? 0,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    cacheWriteTokens: row.cacheWriteTokens ?? 0,
    costMetered: row.costBasis === "metered" ? (row.costEstimate ?? "0") : "0",
    costNotional: row.costBasis === "notional" ? (row.costEstimate ?? "0") : "0",
  }
}
export function terminalContribution(row: UsageRequestTerminalInsert): UsageContribution {
  return {
    apiKeyId: row.apiKeyId ?? null,
    accountId: row.accountId ?? null,
    poolId: row.poolId ?? null,
    model: row.model ?? null,
    correlationId: row.correlationId,
    eventAt: row.settledAt.toISOString(),
    requests: 1,
    attempts: 0,
    errors: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMetered: "0",
    costNotional: "0",
  }
}
export class UsageIdentityConflict extends Error {
  constructor() {
    super("immutable usage identity conflicts with committed evidence")
    this.name = "UsageIdentityConflict"
  }
}
export class UsageHistoryExpired extends Error {
  constructor() {
    super("usage event precedes the retained history horizon")
    this.name = "UsageHistoryExpired"
  }
}
