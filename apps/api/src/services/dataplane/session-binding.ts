import { describeError } from "@multi-ai-router/core"
import type { SessionRepository } from "@multi-ai-router/db"
import type { Env } from "../../config/env"
import type { Logger } from "../../logging/logger"
import { createSessionStore, PROVIDER_REGISTRY, type SessionStore } from "../../providers"
import type { SessionCarrier } from "../../providers/claude-sdk/session-carry"
import type { KeyScopeSnapshot, SessionBinding } from "../routing"
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
 * nothing to look up and does not look — nor does a key whose scope reaches no subscription, even
 * beside one elsewhere in the catalog (plan 101, 02.8). A router that gains one starts binding on
 * its next request, because the catalog is read per call rather than captured at construction.
 */

export interface SessionBindings {
  /** The binding to hand selection, or undefined when this session has none. */
  read(
    apiKeyId: string,
    sessionKey: string,
    scope?: KeyScopeSnapshot,
  ): Promise<SessionBinding | undefined>
}

const NONE: SessionBindings = {
  read: () => Promise.resolve(undefined),
}

export function sessionBindings(
  catalog: RoutingCatalog,
  store: SessionStore | undefined,
  timing?: { readonly elapsed: () => number; readonly onWait: (milliseconds: number) => void },
): SessionBindings {
  if (store === undefined) return NONE
  const reach = subscriptionReach(catalog)

  return {
    async read(apiKeyId, sessionKey, scope = { kind: "all" }) {
      if (!reach(scope)) return undefined
      const started = timing?.elapsed()
      try {
        return await store.binding(apiKeyId, sessionKey)
      } finally {
        if (started !== undefined) timing?.onWait(Math.max(0, timing.elapsed() - started))
      }
    },
  }
}

/**
 * Whether a key scope can reach any subscription account. The id and pool sets are rebuilt only
 * when the catalog installs new arrays, not per request.
 */
function subscriptionReach(catalog: RoutingCatalog): (scope: KeyScopeSnapshot) => boolean {
  let seen: { accounts: unknown; pools: unknown } | undefined
  let ids = new Set<string>()
  let poolIds = new Set<string>()
  const refresh = () => {
    const accounts = catalog.accounts()
    const pools = catalog.pools()
    if (seen?.accounts === accounts && seen.pools === pools) return
    seen = { accounts, pools }
    ids = new Set(
      accounts
        .filter((account) => PROVIDER_REGISTRY[account.driver.provider].transport === "agent-sdk")
        .map((account) => account.id),
    )
    poolIds = new Set(
      pools
        .filter((pool) => pool.members.some((member) => ids.has(member.accountId)))
        .map((pool) => pool.id),
    )
  }
  return (scope) => {
    refresh()
    if (ids.size === 0) return false
    if (scope.kind === "all") return true
    if (scope.kind === "accounts") return scope.accountIds.some((id) => ids.has(id))
    return scope.poolIds.some((id) => poolIds.has(id))
  }
}

export interface SessionStoreEnvDeps {
  readonly env: Env
  readonly repository: Pick<SessionRepository, "findByKey" | "upsert" | "clearAccount">
  readonly logger: Logger
  readonly now: () => Date
  /** Wired only when `CLAUDE_SDK_SESSION_CARRY` is on; see `SessionStoreDeps.carrier`. */
  readonly carrier?: SessionCarrier
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
    ...(deps.carrier === undefined ? {} : { carrier: deps.carrier }),
    onCarry: (outcome) => {
      const fields = {
        component: "dataplane",
        fromAccountId: outcome.fromAccountId,
        toAccountId: outcome.toAccountId,
      }
      if (outcome.carried) {
        deps.logger.info("session carried to another account", { ...fields, bytes: outcome.bytes })
        return
      }
      deps.logger.warn("session carry failed; the turn starts fresh", {
        ...fields,
        reason: outcome.reason,
        ...(outcome.error === undefined
          ? {}
          : { detail: describeError(outcome.error, deps.env.logReasonMaxChars) }),
      })
    },
    // Ids and an enum only: never a transcript, a message, or anything from a config directory.
    onCarrySkipped: (skip) => {
      deps.logger.info("bound session not carried; the turn starts fresh", {
        component: "dataplane",
        fromAccountId: skip.fromAccountId,
        toAccountId: skip.toAccountId,
        reason: skip.reason,
      })
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
