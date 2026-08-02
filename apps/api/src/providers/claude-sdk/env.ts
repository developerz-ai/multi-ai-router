/**
 * The environment one Agent SDK subprocess is launched with — everything this host has, minus the
 * variables that would make it dangerous, plus the one that makes it this Account's.
 *
 * Two failures this prevents, both silent:
 *
 * - **Loop-back.** An inherited `ANTHROPIC_BASE_URL` (or `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`)
 *   points the CLI back through our own router — a request that re-enters the data plane, consumes
 *   a second Account, and bills twice, or recurses. Operators set those variables routinely, and
 *   nothing about the resulting request looks wrong from the outside
 *   (docs/idea/11-anthropic-agent-sdk.md#traps-all-load-bearing).
 * - **Cross-tenant credentials.** A host-level `CLAUDE_CODE_OAUTH_TOKEN` overrides the Account's own
 *   login, so every subscription request would silently run as whoever set it — the exact
 *   contamination `CLAUDE_CONFIG_DIR` isolation exists to prevent (§3).
 *
 * The router's own secrets go too. The `claude` CLI has no use for them, and the only thing that
 * could read them is a tool executing on this host — which the allowlist already refuses
 * (`allowlist.ts`). Stripping them anyway costs nothing and means the two mechanisms fail
 * independently.
 *
 * **Stripping is a prefix rule, not a list of names, for the `ANTHROPIC_` family.** A list is a
 * blocklist that goes stale the day Anthropic adds a variable; the prefix is closed over whatever
 * they add. (The allowlist in `allowlist.ts` is the opposite shape for the opposite reason: there
 * the safe default is "deny", here it is "strip".)
 *
 * `PATH` and `HOME` survive on purpose — the SDK spawns a native binary and resolves a JavaScript
 * runtime, and both need them. The SDK **replaces** the child environment with whatever it is
 * given rather than merging, so an environment built here is the whole of what the subprocess sees.
 */

/** Names the CLI to this Account's isolated credential store. Always set here, never inherited. */
export const CLAUDE_CONFIG_DIR_VAR = "CLAUDE_CONFIG_DIR"

/** Every variable starting with one of these is dropped. Case-insensitive. */
export const STRIPPED_ENV_PREFIXES: readonly string[] = Object.freeze(["ANTHROPIC_"])

/** Exact names dropped on top of the prefixes. Case-insensitive. */
export const STRIPPED_ENV_NAMES: readonly string[] = Object.freeze([
  // Subscription credentials the SDK owns. Ours is the config directory, never a token.
  "CLAUDE_CODE_OAUTH_TOKEN",
  CLAUDE_CONFIG_DIR_VAR,
  // The router's own secrets. Nothing in the subprocess has a reason to read them. The list is
  // every secret-bearing name the env schema (`apps/api/src/config/env.ts`) reads; adding a secret
  // there means adding it here, which is why the strip is asserted in the security gate test.
  "ENCRYPTION_KEY",
  "DATABASE_URL",
  "ADMIN_PASSWORD",
  "ADMIN_PASSWORD_HASH",
  "ADMIN_OIDC_CLIENT_SECRET",
  "ADMIN_API_TOKEN",
  "METRICS_TOKEN",
])

/**
 * Variables forced onto every **`query()`** subprocess — the dispatch path and the "Test now"
 * probe — and deliberately *not* onto the login CLI (`login/spawn.ts`), whose interactive output
 * the router scrapes and must not perturb.
 *
 * - `ENABLE_CLAUDEAI_MCP_SERVERS: "false"` — the CLI fetches the subscription's **claude.ai org
 *   connectors** (remote MCP servers) over HTTP whenever the OAuth token carries the
 *   `user:mcp_servers` scope. Its eligibility check (CLI 0.3.220, `[claudeai-mcp]` fetch path)
 *   consults this env var, safe mode, auth precedence, and scopes — **not** `strictMcpConfig`,
 *   which only governs filesystem-configured servers (`.mcp.json` and friends). So this is a
 *   separate door from the one `options.ts` closes: without it, one Account's claude.ai connector
 *   catalog is injected into whichever key holder's request lands on it — a cross-tenant leak, and
 *   surprise egress to servers this router never configured. Provenance: Meridian `query.ts` sets
 *   the same guard for the same reason.
 * - `CLAUDE_CODE_SESSION_KIND: "bg"` — suppresses the CLI's injected "# Scratchpad Directory"
 *   context block, which otherwise advertises a **router-host** path (the subprocess cwd is the
 *   Account's `CLAUDE_CONFIG_DIR`) to the client's model, whose tools execute on the *client*.
 *   `bg` is the CLI's own headless-background mode, which is semantically what this subprocess is;
 *   its other effects are TUI rendering (none here) or `CLAUDE_JOB_DIR`-gated bookkeeping (unset
 *   here) — Meridian #627/#628 audited the same CLI. The known cost: a `bg` session registers as a
 *   running background agent, so a concurrent resume is refused with "is currently running as a
 *   background agent" (Meridian #630) — which `invoker.ts` recovers from with one in-place
 *   `forkSession` retry (`errors.ts` `busy-session`).
 *
 * Applied after {@link subprocessEnv}, so no inherited value can win — these are isolation
 * decisions, not operator knobs.
 */
export const QUERY_ENV_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  CLAUDE_CODE_SESSION_KIND: "bg",
})

export interface SubprocessEnvOptions {
  /** This Account's `CLAUDE_CONFIG_DIR`, already resolved. The value the whole mechanism turns on. */
  readonly configDir: string
  /** What to inherit from. Defaults to `process.env`; injected so a test needs no real environment. */
  readonly inherited?: NodeJS.ProcessEnv
}

/**
 * The child environment, with `CLAUDE_CONFIG_DIR` set last so no inherited value can win.
 *
 * Returns `Record<string, string>`: an `undefined` value is indistinguishable from "unset" to the
 * spawner but not to a reader, and dropping it here means the returned object is exactly what the
 * subprocess gets.
 */
export function subprocessEnv(options: SubprocessEnvOptions): Record<string, string> {
  const inherited = options.inherited ?? process.env
  const env: Record<string, string> = {}

  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined || isStripped(name)) continue
    env[name] = value
  }

  env[CLAUDE_CONFIG_DIR_VAR] = options.configDir
  return env
}

function isStripped(name: string): boolean {
  const upper = name.toUpperCase()
  if (STRIPPED_ENV_NAMES.includes(upper)) return true
  return STRIPPED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
}
