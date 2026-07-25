import type { Logger } from "../../logging/logger"
import { type CliResolution, createCliProbe, resolveClaudeCli } from "../../providers"
import type { ClaudeCliReadiness } from "./readiness"

/**
 * The `claude` half of `/readyz`: which rung of the resolution ladder won.
 *
 * It re-resolves on every call rather than caching a boot-time answer, and that is the useful
 * behaviour: an operator who fixes a bad mount, a missing platform package, or a wrong
 * `CLAUDE_CLI_PATH` sees the endpoint agree without restarting the router. The cost is a handful of
 * `statSync` calls against paths the page cache already holds — nothing that belongs on the request
 * path, and `/readyz` is not the request path.
 *
 * **The resolved path is logged, never returned.** `/readyz` is unauthenticated (a probe that needs
 * a credential fails during exactly the incident it exists to report), so the response names the
 * rung and the log carries the path. The line is written only when the outcome *changes*, so a
 * one-second orchestrator poll does not become a log flood.
 */

export interface ClaudeCliProbeDeps {
  /** `Env.claudeCliPath` — the operator's pin, or null. */
  readonly override: string | null
  readonly log: Logger
  /** Test seam. Production resolves against the real filesystem and module resolver. */
  readonly resolve?: () => CliResolution
}

export function createClaudeCliProbe(deps: ClaudeCliProbeDeps): () => Promise<ClaudeCliReadiness> {
  const resolve =
    deps.resolve ?? (() => resolveClaudeCli(createCliProbe({ override: deps.override })))
  let reported: string | null = null

  return () => {
    const resolution = resolve()
    const current = signature(resolution)
    if (reported !== current) {
      reported = current
      report(deps.log, resolution)
    }
    return Promise.resolve(resolution.ok ? resolution.source : "missing")
  }
}

/** Identity of an outcome for change detection: the winner, or the whole list of refusals. */
function signature(resolution: CliResolution): string {
  if (resolution.ok) return `${resolution.source}:${resolution.path}`
  return resolution.attempts.map((a) => `${a.source}/${a.rejection}/${a.path ?? "-"}`).join(",")
}

function report(log: Logger, resolution: CliResolution): void {
  if (resolution.ok) {
    log.info("claude cli resolved", {
      component: "claude-sdk",
      source: resolution.source,
      path: resolution.path,
      bytes: resolution.bytes,
    })
    return
  }
  // Warn, not error: only Claude subscription accounts need this binary, and a router serving
  // API-key accounts alone is healthy without it.
  log.warn("claude cli not found — Claude subscription accounts cannot be served", {
    component: "claude-sdk",
    attempts: resolution.attempts.map((a) => ({
      source: a.source,
      rejection: a.rejection,
      path: a.path,
    })),
  })
}
