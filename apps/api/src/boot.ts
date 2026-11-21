import { resolve } from "node:path"
import { describeError } from "@multi-ai-router/core"
import {
  createAccountRepository,
  createAdminCredentialRepository,
  type DatabaseHandle,
  runMigrations,
} from "@multi-ai-router/db"
import { createRuntime, type Runtime, type RuntimeDeps } from "./composition"
import { type Env, EnvValidationError, parseEnv } from "./config/env"
import { loadPoolRoster } from "./config/pool-roster"
import type { Logger } from "./logging/logger"
import { captureException, flushSentry } from "./observability"
import { ConfigDirError } from "./providers/claude-sdk/config-dir"
import { ownerHelperBootProblem, ownerHelperUsable } from "./providers/claude-sdk/owner-helper"
import { describeProvider } from "./services/accounts/providers"
import { adminAuthBootProblem } from "./services/admin-auth"

/**
 * The boot steps `main.ts` sequences that can refuse to start the process: each one either
 * returns what the next step needs or exits non-zero with the reason on stderr (or in the log,
 * once the logger exists). Split from `main.ts` so the boot order there reads top to bottom.
 */

/** Exit once GlitchTip has had a bounded chance to send what was just captured. */
export async function exitAfterFlush(env: Env, code: number): Promise<never> {
  await flushSentry(env.sentryExitFlushMs).catch(() => false)
  process.exit(code)
}

/**
 * The one setting that trades a security property for reachability, so it announces itself on
 * every boot rather than only in the file where it was set.
 *
 * `warn`, not `info`: the operator who enabled it for a LAN install and later moved the router
 * behind an HTTPS front has no other signal that the session cookie is still riding plaintext,
 * and the boot line is the one thing they will look at when something is wrong.
 */
export function warnOnInsecureSessionCookie(env: Env, logger: Logger): void {
  if (!env.adminAuth.sessionCookieInsecure) return
  logger.warn("SESSION_COOKIE_INSECURE is on — the admin session cookie is not Secure", {
    component: "admin-auth",
    risk: "the session rides plaintext and any host sharing this domain can set it; unset this once the console is served over HTTPS",
  })
}

/**
 * A deployment holding Claude subscription Accounts does not start without the credential-owner
 * helper every one of their subprocesses is launched through. Without this the missing file is
 * found by the first scheduled task or request to spawn it, long after boot (#447). After
 * migrations for the same reason as the sign-in rule: which Accounts exist is a set of rows.
 */
export async function assertCliOwnerHelperUsable(
  env: Env,
  database: DatabaseHandle,
  logger: Logger,
): Promise<void> {
  const helperPath = resolve(env.cliOwnership.helperPath)
  const summaries = await createAccountRepository(database.db).listSummaries()
  const accountsNeedingHelper = summaries.filter(
    (account) =>
      account.status !== "disabled" && describeProvider(account.provider).requiresConfigDir,
  ).length
  const problem = ownerHelperBootProblem({
    helperPath,
    usable: ownerHelperUsable(helperPath),
    accountsNeedingHelper,
  })
  if (problem === null) return
  logger.error("credential-owner helper is missing or not executable — refusing to start", {
    component: "claude-sdk",
    helperPath,
    accountsNeedingHelper,
  })
  process.stderr.write(`${problem}\n`)
  process.exit(1)
}

/**
 * The one boot rule `parseEnv` cannot own: "an OIDC relying party OR a local
 * admin credential must exist" — the credential's existence is a database row,
 * so the check runs after migrations and before the listener. The refusal
 * mirrors the env-validation UX: stderr, the remedy, the doc, exit non-zero.
 *
 * When the local door *is* open it announces itself the way
 * `SESSION_COOKIE_INSECURE` does: the operator who enabled it for a laptop and
 * later pointed the router at a public address has no other signal.
 */
export async function assertAdminSignInConfigured(
  env: Env,
  database: DatabaseHandle,
  logger: Logger,
): Promise<void> {
  const localCredential = await createAdminCredentialRepository(database.db).get()
  const problem = adminAuthBootProblem({
    oidcConfigured: env.adminOidc !== null,
    localCredentialConfigured: localCredential !== undefined,
    publicUrl: env.publicUrl,
    allowPublicLocalLogin: env.adminAuth.localLoginAllowPublic,
  })
  if (problem !== null) {
    process.stderr.write(`${problem}\n`)
    process.exit(1)
  }

  if (localCredential === undefined) return
  logger.info("admin sign-in: local password is enabled", {
    component: "admin-auth",
    oidc: env.adminOidc !== null,
  })
  if (env.adminAuth.localLoginAllowPublic) {
    logger.warn("ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC is on — a password-only admin door is reachable", {
      component: "admin-auth",
      risk: "the local admin password has no IdP and no MFA in front of it; prefer OIDC for anything but this machine, and see docs/idea/13-admin-oidc.md",
    })
  }
}

/** A malformed environment exits non-zero naming the offending variable, and never starts. */
export function readEnv(): Env {
  try {
    const env = parseEnv(process.env)
    return { ...env, poolRoster: loadPoolRoster(env.poolRosterPath) }
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}

/**
 * A `CLAUDE_CONFIG_ROOT` that would break subscription OAuth exits the same way a malformed env
 * var does. It is only knowable here — the check needs this host's home directory, which `parseEnv`
 * is deliberately unable to read.
 */
export function buildRuntime(deps: RuntimeDeps): Runtime {
  try {
    return createRuntime(deps)
  } catch (error) {
    if (error instanceof ConfigDirError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}

export async function migrate(env: Env, logger: Logger): Promise<void> {
  try {
    await runMigrations({
      url: env.databaseUrl,
      connectTimeoutSeconds: env.databasePool.connectTimeoutSeconds,
      lockTimeoutMs: env.migrationLockTimeoutMs,
      onLockWait: () =>
        logger.info("another replica holds the migration lock — waiting", { component: "db" }),
    })
    logger.info("migrations applied", { component: "db" })
  } catch (error) {
    // The full cause chain, innermost first: at this one moment the operator must know *why*,
    // and the wrapper's message alone is the statement, not the reason. A Postgres outage here is
    // an AggregateError whose own message is empty. Unbounded on purpose — the logger redacts,
    // and a pre-cut could split a credential right where the scrub would have matched.
    logger.error("migration failed — refusing to serve a half-migrated schema", {
      component: "db",
      errorClass: error instanceof Error ? error.name : "unknown",
      reason: describeError(error, Number.POSITIVE_INFINITY),
    })
    captureException(error, { tags: { errorClass: "migration_failure" } })
    await exitAfterFlush(env, 1)
  }
}
