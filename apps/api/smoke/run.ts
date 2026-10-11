/**
 * `bin/smoke` — a one-command live check against a deployed router.
 *
 * Sends eight legs through three endpoints and grades each one against the contract of what the
 * router promises to do end to end: a plain text turn, a forced tool call, `tool_choice: any`, the
 * tool-result round trip, a streamed forced tool, reasoning plus a forced tool — all on
 * `/v1/messages` — plus informational legs on `/v1/chat/completions` and `/v1/responses` that an
 * account may legitimately refuse and never decide the exit code.
 *
 * The runner is small on purpose: every leg is one function call, every grader is in `./grade.ts`,
 * and the file that boots production carries no smoke logic. #178 runs these legs by hand; this
 * makes them one command for #185 and for every later provider add.
 *
 * Exit codes, named in `report.ts`:
 *   0  every required leg PASS
 *   1  at least one required leg FAIL
 *   2  no FAIL, but at least one required leg INCONCLUSIVE (key missing, DNS, timeout)
 *  64  usage error (a flag's value is missing, an unknown flag, `--help` was not the request)
 *
 * No request or response body is logged in full — the report line carries the leg name, the
 * status, and the verdict reason; nothing else.
 */

import { type CliOptions, type ParsedOptions, type ParseFailure, parseArgs, USAGE } from "./args"
import { grade, type LegOutcome, type LegSpec } from "./grade"
import { buildBody, buildLegs } from "./legs"
import {
  buildReport,
  decideExitCode,
  type LegRunResult,
  renderReport,
  type SmokeReport,
} from "./report"
import { parseSse } from "./sse"

const TIMEOUT_MS = 30_000

export type { LegOutcome, LegRunResult, LegSpec, SmokeReport }
export {
  buildBody,
  buildLegs,
  buildReport,
  type CliOptions,
  decideExitCode,
  type ParsedOptions,
  type ParseFailure,
  parseArgs,
  parseSse,
  renderReport,
  USAGE,
}

interface DriveOptions {
  readonly url: string
  readonly model: string
  readonly key: string | null
  readonly legs: readonly LegSpec[]
  readonly fetchImpl?: typeof fetch
}

/**
 * Drives every leg against the router. Returns the per-leg outcomes the caller renders. Each leg
 * runs sequentially: a runner is one user, and a runner that fans out would race its own budget.
 */
export async function runLegs(options: DriveOptions): Promise<readonly LegRunResult[]> {
  const fetcher = options.fetchImpl ?? fetch
  const out: LegRunResult[] = []
  for (const leg of options.legs) {
    out.push(await driveLeg(leg, options, fetcher))
  }
  return out
}

async function driveLeg(
  leg: LegSpec,
  options: DriveOptions,
  fetcher: typeof fetch,
): Promise<LegRunResult> {
  if (options.key === null) {
    return {
      leg,
      outcome: { verdict: "INCONCLUSIVE", reason: "key-unset" },
      status: null,
    }
  }

  const url = `${options.url.replace(/\/$/, "")}${leg.endpoint}`
  const body = buildBody(leg, options.model)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let status: number
  let parsed: unknown
  let events: readonly import("./grade").StreamEvent[] = []
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${options.key}`,
      "x-api-key": options.key,
    }
    if (leg.stream) headers.accept = "text/event-stream"

    const response = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const result = await readResponse(response, leg.stream)
    status = result.status
    parsed = result.parsed
    events = result.events
  } catch (error) {
    clearTimeout(timer)
    if (error instanceof Error && (error.name === "AbortError" || controller.signal.aborted)) {
      return { leg, outcome: { verdict: "INCONCLUSIVE", reason: "timeout" }, status: null }
    }
    return {
      leg,
      outcome: { verdict: "INCONCLUSIVE", reason: reasonFromFetchError(error) },
      status: null,
    }
  }
  clearTimeout(timer)
  // Grade sits outside the fetch try: a malformed body is FAIL `malformed-body`, not INCONCLUSIVE
  // `network`. The grader is a pure function; it has no I/O to fail open. The try/catch below is
  // the backstop against a body that defeats the type guards and throws on template-literal
  // coercion — e.g. `{stop_reason: {toString: 1}}` — so the runner reports FAIL rather than
  // rejecting and aborting the rest of the legs.
  try {
    return { leg, outcome: grade(leg, status, parsed, events), status }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      leg,
      outcome: { verdict: "FAIL", reason: `malformed-body:${detail}` },
      status,
    }
  }
}

interface ReadResponse {
  readonly status: number
  readonly parsed: unknown
  readonly events: readonly import("./grade").StreamEvent[]
}

async function readResponse(response: Response, stream: boolean): Promise<ReadResponse> {
  const status = response.status
  const text = await response.text()
  if (!stream) return { status, parsed: safeJson(text), events: [] }
  return { status, parsed: undefined, events: parseSse(text) }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function reasonFromFetchError(error: unknown): string {
  if (error instanceof TypeError) return "network"
  if (error instanceof Error) return "fetch-error"
  return "unknown"
}

/**
 * Reads the API key from `process.env[keyEnv]`. Returns `null` when it is unset or empty so the
 * runner marks every leg INCONCLUSIVE with reason `key-unset` rather than attempting an
 * unauthenticated call. The key is **never** logged: the report names `keyEnv`, not the value,
 * and the runner does not echo it on the wire anywhere except the request header.
 */
export function readKey(keyEnv: string): string | null {
  const raw = process.env[keyEnv]
  if (raw === undefined || raw.length === 0) return null
  return raw
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`)
    return 64
  }
  if (parsed.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const key = readKey(parsed.keyEnv)
  const legs = buildLegs()
  const results = await runLegs({ url: parsed.url, model: parsed.model, key, legs })

  const report = buildReport(parsed, results)
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(renderReport(report))
  }
  return decideExitCode(results)
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      // Usage-shape failures land here only if the runner itself throws past `parseArgs`. A
      // distinct exit code keeps this from colliding with INCONCLUSIVE (2).
      process.exitCode = 64
    })
}
