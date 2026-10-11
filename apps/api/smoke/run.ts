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
 * Exit codes, named in `grade.ts`:
 *   0  every required leg PASS
 *   1  at least one required leg FAIL
 *   2  no FAIL, but at least one required leg INCONCLUSIVE (key missing, DNS, timeout, 5xx-only)
 *  64  usage error (a flag's value is missing, an unknown flag, `--help` was not the request)
 *
 * No request or response body is logged in full — the report line carries the leg name, the
 * status, and the verdict reason; nothing else.
 */

import {
  grade,
  type LegOutcome,
  type LegSpec,
  type MessagesLeg,
  type OpenAiLeg,
  type StreamEvent,
} from "./grade"

const TOOL_NAME = "get_weather"
const TIMEOUT_MS = 30_000

const USAGE = `Usage: bin/smoke [options]

  --url URL          the router's base URL          (required)
  --model ID         the model id to address        (required)
  --key-env NAME     read the API key from process.env[NAME] (required)
  --json             emit the report as JSON
  --help             this

The key is read from the named environment variable only. It is never accepted as an argument and
never printed. Required legs run on /v1/messages; informational legs run on /v1/chat/completions
and /v1/responses. Required legs decide the exit code; informational legs never do.
`

interface CliOptions {
  readonly url: string
  readonly model: string
  readonly keyEnv: string
  readonly json: boolean
  readonly help: boolean
}

interface ParsedOptions extends CliOptions {
  readonly ok: true
}

interface ParseFailure {
  readonly ok: false
  readonly message: string
}

const REQUIRED_LEGS: readonly string[] = [
  "messages.text",
  "messages.forced_tool",
  "messages.tool_choice_any",
  "messages.tool_round_trip",
  "messages.streamed_forced_tool",
  "messages.reasoning_forced_tool",
]

interface LegRunResult {
  readonly leg: LegSpec
  readonly outcome: LegOutcome
  /** HTTP status of the call, or `null` if the runner never reached the wire. */
  readonly status: number | null
}

interface SmokeReport {
  readonly url: string
  readonly model: string
  readonly keyEnv: string
  readonly legs: ReadonlyArray<{
    readonly name: string
    readonly endpoint: string
    readonly stream: boolean
    readonly required: boolean
    readonly verdict: LegOutcome["verdict"]
    readonly reason?: string
    readonly status: number | null
  }>
}

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
    const flag = argv[index]
    if (flag === undefined) continue
    if (flag === "--help" || flag === "-h") {
      help = true
      continue
    }
    if (flag === "--json") {
      json = true
      continue
    }
    if (flag === "--url" || flag === "--model" || flag === "--key-env") {
      const raw = argv[index + 1]
      if (raw === undefined) {
        return { ok: false, message: `${flag} needs a value\n\n${USAGE}` }
      }
      if (flag === "--url") url = raw
      else if (flag === "--model") model = raw
      else keyEnv = raw
      index += 1
      continue
    }
    return { ok: false, message: `unknown option ${flag}\n\n${USAGE}` }
  }

  if (url === undefined || model === undefined || keyEnv === undefined) {
    return {
      ok: false,
      message: `--url, --model and --key-env are all required\n\n${USAGE}`,
    }
  }
  return { ok: true, url, model, keyEnv, json, help }
}

export function buildLegs(): readonly LegSpec[] {
  const messages: readonly MessagesLeg[] = [
    {
      endpoint: "/v1/messages",
      stream: false,
      name: "messages.text",
      expectation: { kind: "text" },
    },
    {
      endpoint: "/v1/messages",
      stream: false,
      name: "messages.forced_tool",
      expectation: { kind: "forced_tool", name: TOOL_NAME },
    },
    {
      endpoint: "/v1/messages",
      stream: false,
      name: "messages.tool_choice_any",
      expectation: { kind: "tool_choice_any" },
    },
    {
      endpoint: "/v1/messages",
      stream: false,
      name: "messages.tool_round_trip",
      expectation: { kind: "tool_round_trip" },
    },
    {
      endpoint: "/v1/messages",
      stream: true,
      name: "messages.streamed_forced_tool",
      expectation: { kind: "streamed_forced_tool", name: TOOL_NAME },
    },
    {
      endpoint: "/v1/messages",
      stream: false,
      name: "messages.reasoning_forced_tool",
      expectation: { kind: "reasoning_forced_tool", name: TOOL_NAME },
    },
  ]
  const informational: readonly OpenAiLeg[] = [
    {
      endpoint: "/v1/chat/completions",
      stream: false,
      name: "chat_completions.required_tool",
      expectation: { kind: "chat_completions_required_tool" },
      required: false,
    },
    {
      endpoint: "/v1/responses",
      stream: false,
      name: "responses.function_call",
      expectation: { kind: "responses_function_call" },
      required: false,
    },
  ]
  return [...messages, ...informational]
}

interface DriveOptions {
  readonly url: string
  readonly model: string
  readonly key: string | null
  readonly legs: readonly LegSpec[]
  readonly fetchImpl?: typeof fetch
  /** Injected so a unit test can stub it; production leaves it default. */
  readonly now?: () => Date
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
    return { leg, outcome: { verdict: "INCONCLUSIVE" }, status: null }
  }

  const url = `${options.url.replace(/\/$/, "")}${leg.endpoint}`
  const body = buildBody(leg, options.model)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${options.key}`,
      "x-api-key": options.key,
    }
    if (leg.stream) {
      headers.accept = "text/event-stream"
    }

    const response = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const { status, parsed, events } = await readResponse(response, leg.stream)
    const outcome = grade(leg, status, parsed, events)
    return { leg, outcome, status }
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || controller.signal.aborted)) {
      return { leg, outcome: { verdict: "INCONCLUSIVE", reason: "timeout" }, status: null }
    }
    return {
      leg,
      outcome: { verdict: "INCONCLUSIVE", reason: reasonFromFetchError(error) },
      status: null,
    }
  } finally {
    clearTimeout(timer)
  }
}

interface ReadResponse {
  readonly status: number
  readonly parsed: unknown
  readonly events: readonly StreamEvent[]
}

async function readResponse(response: Response, stream: boolean): Promise<ReadResponse> {
  const status = response.status
  const text = await response.text()

  if (!stream) {
    return { status, parsed: safeJson(text), events: [] }
  }
  const events = parseSse(text)
  return { status, parsed: undefined, events }
}

function parseSse(text: string): readonly StreamEvent[] {
  const events: StreamEvent[] = []
  let eventName: string | undefined
  let dataLines: string[] = []

  const flush = (): void => {
    if (eventName === undefined && dataLines.length === 0) return
    const dataText = dataLines.join("\n")
    if (eventName !== undefined && dataText.length > 0) {
      events.push({ event: eventName, data: safeJson(dataText) })
    }
    eventName = undefined
    dataLines = []
  }

  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) {
      flush()
      continue
    }
    if (line.startsWith(":")) {
      // comment / heartbeat — ignored
      continue
    }
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim()
      continue
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim())
    }
    // Unknown line, ignore — be lenient on whitespace and stray fields.
  }
  flush()
  return events
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function reasonFromFetchError(error: unknown): string {
  if (error instanceof TypeError) {
    return "network"
  }
  if (error instanceof Error) {
    return "fetch-error"
  }
  return "unknown"
}

function buildBody(leg: LegSpec, model: string): unknown {
  if (leg.endpoint === "/v1/messages") return buildMessagesBody(leg, model)
  if (leg.endpoint === "/v1/chat/completions") return buildChatCompletionsBody(leg, model)
  return buildResponsesBody(leg, model)
}

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description: "Return the current weather for a city.",
  input_schema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
}

function buildMessagesBody(leg: MessagesLeg, model: string): unknown {
  switch (leg.expectation.kind) {
    case "text":
      return {
        model,
        max_tokens: 64,
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
      }
    case "forced_tool":
      return {
        model,
        max_tokens: 64,
        tools: [TOOL_DEFINITION],
        tool_choice: { type: "tool", name: leg.expectation.name },
        messages: [{ role: "user", content: "What's the weather in Paris?" }],
      }
    case "tool_choice_any":
      return {
        model,
        max_tokens: 64,
        tools: [TOOL_DEFINITION],
        tool_choice: { type: "any" },
        messages: [{ role: "user", content: "Anything you can do." }],
      }
    case "tool_round_trip":
      return {
        model,
        max_tokens: 64,
        tools: [TOOL_DEFINITION],
        messages: [
          { role: "user", content: "Weather in Paris?" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_round_trip_1",
                name: TOOL_NAME,
                input: { city: "Paris" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_round_trip_1",
                content: '{"temperature_c":18}',
              },
            ],
          },
        ],
      }
    case "streamed_forced_tool":
      return {
        model,
        max_tokens: 64,
        stream: true,
        tools: [TOOL_DEFINITION],
        tool_choice: { type: "tool", name: leg.expectation.name },
        messages: [{ role: "user", content: "Weather in Paris?" }],
      }
    case "reasoning_forced_tool":
      return {
        model,
        max_tokens: 256,
        thinking: { type: "enabled", budget_tokens: 64 },
        tools: [TOOL_DEFINITION],
        tool_choice: { type: "tool", name: leg.expectation.name },
        messages: [{ role: "user", content: "Weather in Paris?" }],
      }
  }
}

function buildChatCompletionsBody(leg: OpenAiLeg, model: string): unknown {
  switch (leg.expectation.kind) {
    case "chat_completions_required_tool":
      return {
        model,
        tools: [
          {
            type: "function",
            function: {
              name: TOOL_NAME,
              description: "Return the current weather for a city.",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ],
        tool_choice: "required",
        messages: [{ role: "user", content: "Weather in Paris?" }],
      }
    case "responses_function_call":
      // The `/v1/responses` leg uses the OpenAI Responses shape. Falls through below.
      return buildResponsesBody(leg, model)
  }
}

function buildResponsesBody(leg: OpenAiLeg, model: string): unknown {
  if (leg.expectation.kind !== "responses_function_call") {
    throw new Error("internal: buildResponsesBody called for non-Responses leg")
  }
  return {
    model,
    tools: [
      {
        type: "function",
        name: TOOL_NAME,
        description: "Return the current weather for a city.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
    input: "Weather in Paris?",
  }
}

export function decideExitCode(results: readonly LegRunResult[]): number {
  let failed = false
  let inconclusive = false
  for (const result of results) {
    if (!isRequired(result.leg)) continue
    if (result.outcome.verdict === "FAIL") failed = true
    if (result.outcome.verdict === "INCONCLUSIVE") inconclusive = true
  }
  if (failed) return 1
  if (inconclusive) return 2
  return 0
}

export function renderReport(report: SmokeReport): string {
  const lines: string[] = []
  lines.push(`bin/smoke ${report.url} model=${report.model} key=${report.keyEnv}`)
  for (const leg of report.legs) {
    const verdict = leg.verdict
    const reason = leg.reason === undefined ? "" : ` (${leg.reason})`
    const status = leg.status === null ? "—" : String(leg.status)
    const required = leg.required ? "required " : "informational "
    lines.push(`  ${leg.name.padEnd(34)} ${required}${status} ${verdict}${reason}`)
  }
  return `${lines.join("\n")}\n`
}

export function buildReport(options: CliOptions, results: readonly LegRunResult[]): SmokeReport {
  return {
    url: options.url,
    model: options.model,
    keyEnv: options.keyEnv,
    legs: results.map((result) => ({
      name: result.leg.name,
      endpoint: result.leg.endpoint,
      stream: result.leg.stream,
      required: isRequired(result.leg),
      verdict: result.outcome.verdict,
      ...(result.outcome.reason === undefined ? {} : { reason: result.outcome.reason }),
      status: result.status,
    })),
  }
}

function isRequired(leg: LegSpec): boolean {
  if (leg.endpoint !== "/v1/chat/completions" && leg.endpoint !== "/v1/responses") return true
  return REQUIRED_LEGS.includes(leg.name)
}

/**
 * Reads the API key from `process.env[keyEnv]`. Returns `null` when it is unset or empty so the
 * runner marks every leg INCONCLUSIVE rather than attempting an unauthenticated call.
 *
 * The key is **never** logged: the report names `keyEnv`, not the value, and the runner does not
 * echo it on the wire anywhere except the request header.
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
