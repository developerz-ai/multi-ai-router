import type { AccountRepository } from "@multi-ai-router/db"
import type { Env } from "../../../config/env"
import type { Logger } from "../../../logging/logger"
import { createCliProbe, resolveClaudeCli } from "../../../providers"
import type { AccountConfigDirs } from "../../../providers/claude-sdk/config-dir"
import {
  type ClaudeAuthCheck,
  type ClaudeCliLogin,
  ClaudeLoginError,
  createClaudeAuthCheck,
  createClaudeCliLogin,
  createCredentialGuard,
} from "../../../providers/claude-sdk/login"
import type { AuditRecorder } from "../../admin/audit"
import { type AccountAuthProbe, createClaudeAuthProbe } from "../../health/claudeAuthProbe"
import { type ClaudeConnectService, createClaudeConnectService } from "./claude"

/**
 * The two things the router does by *running* the `claude` binary — connecting an Account and
 * asking whether it is still connected — wired for production from one env.
 *
 * They are built together because they are one dependency: the same binary, the same isolated
 * environment, the same `LoginSpawn` seam that `bin/test` may never cross. Splitting the wiring
 * would mean two places that resolve the CLI and two chances for them to disagree about which one
 * they resolved.
 *
 * **The path is resolved per call, not at construction.** `resolveClaudeCli` walks a ladder ending
 * at `PATH`, and an operator who fixes a bad mount, a missing platform package, or a wrong
 * `CLAUDE_CLI_PATH` must not have to restart the router to be believed — the same reason
 * `services/health/claudeCliProbe.ts` re-resolves on every `/readyz`. The cost is a handful of
 * `statSync` calls against paths the page cache already holds, on the admin plane, on a button
 * press.
 *
 * The two halves disagree about what "no binary" means, deliberately. A connect that cannot run is
 * an operator-facing failure and says so; a status check that cannot run reports *nothing*, because
 * a probe that mistook a missing binary for a revoked credential would drop healthy Accounts out of
 * routing (`../../health/claudeAuthProbe.ts`).
 */

export interface ClaudeCliStack {
  readonly connect: ClaudeConnectService
  readonly authProbe: AccountAuthProbe
}

export interface ClaudeCliFromEnvDeps {
  readonly accounts: Pick<AccountRepository, "findById" | "update" | "updateStatus">
  readonly configDirs: AccountConfigDirs
  readonly audit: AuditRecorder
  readonly env: Pick<Env, "claudeCliPath" | "retention">
  readonly logger: Logger
  readonly now: () => Date
}

export function claudeCliFromEnv(deps: ClaudeCliFromEnvDeps): ClaudeCliStack {
  const cliPath = (): string | null => {
    const resolution = resolveClaudeCli(createCliProbe({ override: deps.env.claudeCliPath }))
    return resolution.ok ? resolution.path : null
  }

  const login: ClaudeCliLogin = {
    start: (input) => {
      const path = cliPath()
      if (path === null) {
        // The rungs it tried, and why each was refused, are already in the boot log and in
        // `/readyz`. An operator gets the sentence; the diagnosis stays where it belongs.
        throw new ClaudeLoginError(
          "cli_unavailable",
          "this router has no usable claude binary, so a subscription cannot be connected — see /readyz",
        )
      }
      return createClaudeCliLogin({ cliPath: path }).start(input)
    },
  }

  const cli: ClaudeAuthCheck = {
    check: (configDir) => {
      const path = cliPath()
      return path === null
        ? Promise.resolve(null)
        : createClaudeAuthCheck({ cliPath: path }).check(configDir)
    },
  }

  return {
    connect: createClaudeConnectService({
      accounts: deps.accounts,
      configDirs: deps.configDirs,
      login,
      credentials: createCredentialGuard(),
      audit: deps.audit,
      // The same one-shot window the reverse-engineered flows use, and config rather than a
      // constant (non-negotiable 11). Its timer is what terminates an abandoned subprocess.
      pendingLoginMinutes: deps.env.retention.oauthStateMinutes,
      logger: deps.logger,
      now: deps.now,
    }),
    authProbe: createClaudeAuthProbe({
      accounts: deps.accounts,
      configDirs: deps.configDirs,
      cli,
      audit: deps.audit,
      now: deps.now,
    }),
  }
}
