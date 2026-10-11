/**
 * CLI parsing for `bin/smoke`. The runner reads its inputs from argv with one rule: the key is
 * never accepted as a flag value. The `--key-env` flag takes only a name shaped like a shell
 * identifier, never a value shaped like a key — a name that begins with `ROUTER_KEY_PREFIX`
 * (`mar_live_`) is refused at the parse step, so neither the runner's stdout, stderr nor the
 * JSON `keyEnv` field can echo it.
 */

import { ROUTER_KEY_PREFIX } from "@multi-ai-router/core"

export const USAGE = `Usage: bin/smoke [options]

  --url URL          the router's base URL          (required)
  --model ID         the model id to address        (required)
  --key-env NAME     read the API key from process.env[NAME] (required)
  --json             emit the report as JSON
  --help             this

The key is read from the named environment variable only. It is never accepted as an argument and
never printed. Required legs run on /v1/messages; informational legs run on /v1/chat/completions
and /v1/responses. Required legs decide the exit code; informational legs never do.
`

export interface CliOptions {
  readonly url: string
  readonly model: string
  readonly keyEnv: string
  readonly json: boolean
  readonly help: boolean
}

export interface ParsedOptions extends CliOptions {
  readonly ok: true
}

export interface ParseFailure {
  readonly ok: false
  readonly message: string
}

/**
 * A name is a shell identifier (POSIX-ish: starts with letter or `_`, then letters / digits / `_`).
 * Anything else is refused — the key never travels through this path, so a key-looking value
 * (`mar_live_…`) is also refused here as belt-and-braces against the "I read it from the
 * environment, honest" mistake. The prefix test mirrors `looksLikeRouterKey` in
 * `apps/api/src/middleware/adminAuth.ts`.
 */
const KEY_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function parseArgs(argv: readonly string[]): ParsedOptions | ParseFailure {
  let url: string | undefined
  let model: string | undefined
  let keyEnv: string | undefined
  let json = false
  let help = false

  // `--help` short-circuits before the required-arg check: the operator typing
  // `bin/smoke --help` should see the usage, not a "missing --url" error.
  if (argv.includes("--help") || argv.includes("-h")) {
    return { ok: true, url: "", model: "", keyEnv: "", json: false, help: true }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    if (raw === undefined) continue
    const { flag, value } = splitFlag(raw)
    if (flag === "--help" || flag === "-h") {
      help = true
      continue
    }
    if (flag === "--json") {
      if (value !== undefined) {
        return { ok: false, message: `--json does not take a value\n\n${USAGE}` }
      }
      json = true
      continue
    }
    if (flag === "--url" || flag === "--model" || flag === "--key-env") {
      const provided = value ?? argv[index + 1]
      if (provided === undefined) {
        return { ok: false, message: `${flag} needs a value\n\n${USAGE}` }
      }
      if (value === undefined) index += 1
      if (flag === "--url") {
        url = provided
      } else if (flag === "--model") {
        model = provided
      } else {
        if (!KEY_ENV_NAME_PATTERN.test(provided)) {
          return {
            ok: false,
            message: `--key-env value must match ${KEY_ENV_NAME_PATTERN.source}\n\n${USAGE}`,
          }
        }
        if (provided.startsWith(ROUTER_KEY_PREFIX)) {
          return {
            ok: false,
            message: `--key-env value must name an environment variable, not a key\n\n${USAGE}`,
          }
        }
        keyEnv = provided
      }
      continue
    }
    // Unknown option: print "at position N" so the operator can find it in argv without the value
    // they typed being echoed.
    return {
      ok: false,
      message: `unknown option at position ${index + 1}\n\n${USAGE}`,
    }
  }

  if (url === undefined || model === undefined || keyEnv === undefined) {
    return {
      ok: false,
      message: `--url, --model and --key-env are all required\n\n${USAGE}`,
    }
  }
  return { ok: true, url, model, keyEnv, json, help }
}

/**
 * Splits a single argv entry into a `flag` and a `value` when the caller wrote `--flag=value`. A
 * space-separated form (`--flag`, value) returns the flag and `value === undefined`; the caller
 * looks at `argv[index + 1]`. Bare `--flag` (no `=`) is the same as space-separated. Only one
 * split is performed — a `=` inside the value (it shouldn't happen here) keeps everything on the
 * flag side.
 */
function splitFlag(raw: string): {
  readonly flag: string
  readonly value: string | undefined
} {
  const eq = raw.indexOf("=")
  if (eq === -1) return { flag: raw, value: undefined }
  return { flag: raw.slice(0, eq), value: raw.slice(eq + 1) }
}
