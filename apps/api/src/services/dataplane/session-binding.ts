import { describeError } from "@multi-ai-router/core"
import type { SessionRepository } from "@multi-ai-router/db"
import type { Env } from "../../config/env"
import type { Logger } from "../../logging/logger"
import { createSessionStore, PROVIDER_REGISTRY, type SessionStore } from "../../providers"
import type { SessionBinding } from "../routing"
import type { RoutingCatalog } from "./types"

/**
 * Whether this request even has a binding to read, and the one lookup that answers it.
 *
 * Selection cannot place a bound session itself — an SDK session id resumes only on the Account
 * that minted it — so the binding has to be read **before** selection runs, on the request path.
 * The performance budget allows exactly this shape and no more: a warm cache, and a single indexed
 * query on a miss (docs/idea/01-architecture.md).
 *
 * The gate is what keeps it that cheap for everyone else. Only the Agent-SDK path ever writes a
 * binding — an HTTP session's placement is recomputed by rendezvous hashing every request and
 * hopping costs a cold prompt cache, nothing more — so a router with no subscription Account has
 * nothing to look up and does not look. A router that gains one starts binding on its next
 * request, because the catalog is read per call rather than captured at construction.
 */

export interface SessionBindings {
  /** The binding to hand selection, or undefined when this session has none. */
  read(apiKeyId: string, sessionKey: string): Promise<SessionBinding | undefined>
  /**
   * Selection refused it. The mapping is dropped, never moved: re-pointing it at the account
   * selection chose instead would hand the next request a resume token that upstream never issued.
   */
  invalidate(apiKeyId: string, sessionKey: string): void
}

const NONE: SessionBindings = {
  read: () => Promise.resolve(undefined),
  invalidate: () => {},
}

export function sessionBindings(
  catalog: RoutingCatalog,
  store: SessionStore | undefined,
): SessionBindings {
  if (store === undefined) return NONE

  return {
    read: async (apiKeyId, sessionKey) =>
      servesSubscriptions(catalog) ? store.binding(apiKeyId, sessionKey) : undefined,
    invalidate: (apiKeyId, sessionKey) => store.invalidate(apiKeyId, sessionKey),
  }
}

function servesSubscriptions(catalog: RoutingCatalog): boolean {
  return catalog
    .accounts()
    .some((account) => PROVIDER_REGISTRY[account.driver.provider].transport === "agent-sdk")
}

export interface SessionStoreEnvDeps {
  readonly env: Env
  readonly repository: Pick<SessionRepository, "findByKey" | "upsert">
  readonly logger: Logger
  readonly now: () => Date
}

/**
 * The production store, with the operator's cache knobs applied and its failures pointed at the
 * logger. One place converts `env` into cache options, so the two cannot drift.
 *
 * A read or write that fails here is warned about and then ignored: the turn is still answered,
 * just from a fresh SDK session, and a session table having a bad minute must not become an outage.
 */
export function sessionStoreFromEnv(deps: SessionStoreEnvDeps): SessionStore {
  const { dataPlane } = deps.env
  return createSessionStore({
    repository: deps.repository,
    now: deps.now,
    cache: {
      maxEntries: dataPlane.sessionCacheMax,
      ttlMs: dataPlane.sessionCacheTtlSeconds * 1_000,
      negativeTtlMs: dataPlane.sessionCacheNegativeTtlSeconds * 1_000,
    },
    onError: (operation, error) => {
      // The full cause chain, innermost first: a repository failure here wraps the driver's
      // complaint, and the wrapper alone names the statement, not the reason. The logger redacts.
      deps.logger.warn("session binding unavailable", {
        component: "dataplane",
        operation,
        reason: describeError(error, deps.env.logReasonMaxChars),
      })
    },
  })
}
