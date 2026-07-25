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
  // The router's own secrets. Nothing in the subprocess has a reason to read them.
  "ENCRYPTION_KEY",
  "DATABASE_URL",
  "ADMIN_PASSWORD",
  "ADMIN_PASSWORD_HASH",
  "METRICS_TOKEN",
])

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
