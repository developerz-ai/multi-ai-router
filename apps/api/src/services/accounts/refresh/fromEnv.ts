import type { AccountRepository } from "@multi-ai-router/db"
import type { Env } from "../../../config/env"
import type { Logger } from "../../../logging/logger"
import type { AuditRecorder } from "../../admin/audit"
import type { RoutingCatalogStore } from "../../catalog"
import type { CredentialCipher } from "../../crypto/cipher"
import { type CredentialRefresher, createCredentialRefresher } from "./refresher"

/**
 * The refresher, wired for production from one env.
 *
 * Two conversions happen here and nowhere else. **The timeout** is the data plane's upstream
 * timeout rather than a knob of its own, for the same reason the connect flow reuses it
 * (`../connect/fromEnv.ts`): it is the same endpoint, at the same provider, asked the same
 * question, and a second setting would be one more thing to get wrong for no operator benefit.
 * **The floor** is stated in seconds by the operator and in milliseconds by the timers, so the
 * multiplication lives at the boundary and the two can never drift.
 *
 * The catalog is passed rather than a callback because there is exactly one thing a status change
 * has to reach: an account parked at `needs_reauth` must leave candidate selection on the next
 * request, not when the catalog's own TTL happens to expire — the same coherence the admin plane's
 * `withCatalogRefresh` decorator buys for a write made in the console.
 */

export interface RefresherFromEnvDeps {
  readonly accounts: Pick<AccountRepository, "list" | "findById" | "update" | "updateStatus">
  readonly cipher: Pick<CredentialCipher, "encrypt" | "decrypt">
  readonly audit: AuditRecorder
  readonly env: Pick<Env, "oauthRefresh" | "failover">
  readonly logger: Logger
  readonly now: () => Date
  readonly catalog: Pick<RoutingCatalogStore, "refresh">
}

export function refresherFromEnv(deps: RefresherFromEnvDeps): CredentialRefresher {
  return createCredentialRefresher({
    accounts: deps.accounts,
    cipher: deps.cipher,
    audit: deps.audit,
    fetch: (request) => fetch(request),
    logger: deps.logger,
    now: deps.now,
    config: {
      leadFraction: deps.env.oauthRefresh.leadFraction,
      minDelayMs: deps.env.oauthRefresh.minDelaySeconds * 1_000,
      maxAttempts: deps.env.oauthRefresh.maxAttempts,
      timeoutMs: deps.env.failover.upstreamTimeoutMs,
    },
    onStatusChanged: () => deps.catalog.refresh(),
  })
}
