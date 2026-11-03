/**
 * The live OSV.dev query: `POST /v1/querybatch` takes a list of `{package, version}` and answers
 * with one result per query, each listing the advisory ids that touch it; `GET /v1/vulns/<id>`
 * returns the advisory itself.
 *
 * A response that cannot be understood — unreachable, non-2xx, unparsable, or a result count that
 * does not match the query count — is `unavailable`, never `clean`. The network is injected, so
 * the unit tests never touch it.
 */

import { z } from "zod"
import type { ResolvedPackage } from "./lockfile"
import { type AdvisoryFinding, type AdvisoryStatus, statusOf } from "./verdict"

/** The live advisory database, the ecosystem the resolved packages are in, and the two knobs. */
export const DEFAULT_OSV_URL = "https://api.osv.dev"
export const ECOSYSTEM = "npm"
export const MAX_QUERIES_PER_REQUEST = 500
export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_RETRIES = 3

/** The base delay of the backoff between retries, doubled per attempt. */
const RETRY_BASE_MS = 100

/** The longest summary a finding carries; OSV summaries are a paragraph more often than a line. */
const SUMMARY_LIMIT = 200

/** A failure that means the assessment did not complete — never "no advisory". */
class OsvUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OsvUnavailableError"
  }
}

const queryBatchResponse = z.object({
  results: z.array(z.object({ vulns: z.array(z.object({ id: z.string() })).nullish() })),
})
const eventSchema = z.object({ introduced: z.string().optional(), fixed: z.string().optional() })
const rangeSchema = z.object({ type: z.string(), events: z.array(eventSchema).optional() })
const affectedSchema = z.object({
  package: z.object({ name: z.string() }),
  ranges: z.array(rangeSchema).optional(),
})
const vulnerabilityResponse = z.object({
  id: z.string(),
  summary: z.string().optional(),
  details: z.string().optional(),
  affected: z.array(affectedSchema).optional(),
  database_specific: z.record(z.string(), z.unknown()).optional(),
})
type Vulnerability = z.infer<typeof vulnerabilityResponse>

/** The options with their defaults filled in. */
type Client = Required<OsvOptions>

export interface OsvOptions {
  readonly baseUrl?: string
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
  readonly retries?: number
}

/** What an assessment produced. */
export interface OsvAssessment {
  readonly status: AdvisoryStatus
  readonly findings: readonly AdvisoryFinding[]
  /** Why the assessment could not complete, or null when it did. */
  readonly error: string | null
  readonly packagesAssessed: number
}

/**
 * Asks the advisory database about every resolved package. Never throws: every failure is an
 * outcome, because the caller writes a report either way.
 */
export async function assess(
  packages: readonly ResolvedPackage[],
  options: OsvOptions = {},
): Promise<OsvAssessment> {
  const client: Client = {
    baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_OSV_URL),
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: options.retries ?? DEFAULT_RETRIES,
  }
  if (packages.length === 0) return unavailable("no resolved packages to assess", 0)
  try {
    const findings = await collectFindings(packages, client)
    return {
      status: statusOf({ findings, error: null }),
      findings,
      error: null,
      packagesAssessed: packages.length,
    }
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error), packages.length)
  }
}

function unavailable(error: string, packagesAssessed: number): OsvAssessment {
  return { status: "unavailable", findings: [], error, packagesAssessed }
}

/** The base URL without its trailing slash, so the paths below can be appended to it. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "")
}

async function collectFindings(
  packages: readonly ResolvedPackage[],
  client: Client,
): Promise<readonly AdvisoryFinding[]> {
  /** Advisory id → the resolved packages it was reported against. */
  const hits = new Map<string, Set<ResolvedPackage>>()
  // OSV takes at most 500 queries per request, and answers with one result per query, in order.
  for (let start = 0; start < packages.length; start += MAX_QUERIES_PER_REQUEST) {
    const chunk = packages.slice(start, start + MAX_QUERIES_PER_REQUEST)
    const results = await queryBatch(chunk, client)
    if (results.length !== chunk.length) {
      throw new OsvUnavailableError(
        `OSV returned ${results.length} results for ${chunk.length} queries — the answer does not ` +
          `cover the dependency set`,
      )
    }
    results.forEach((ids, index) => {
      const target = chunk[index]
      if (target === undefined) return
      for (const id of ids) {
        const targets = hits.get(id) ?? new Set<ResolvedPackage>()
        targets.add(target)
        hits.set(id, targets)
      }
    })
  }
  const findings: AdvisoryFinding[] = []
  for (const [id, targets] of hits) {
    const detail = await fetchVulnerability(id, client)
    for (const target of targets) findings.push(toFinding(id, target, detail))
  }
  return findings.sort(
    (left, right) => left.id.localeCompare(right.id) || left.package.localeCompare(right.package),
  )
}

async function queryBatch(
  chunk: readonly ResolvedPackage[],
  client: Client,
): Promise<readonly (readonly string[])[]> {
  const body = JSON.stringify({
    queries: chunk.map((entry) => ({
      package: { name: entry.name, ecosystem: ECOSYSTEM },
      version: entry.version,
    })),
  })
  const response = await fetchWithRetries(`${client.baseUrl}/v1/querybatch`, "POST", body, client)
  const parsed = queryBatchResponse.safeParse(await readJson(response, "querybatch"))
  if (!parsed.success) {
    throw new OsvUnavailableError(
      `the OSV querybatch response was not the expected shape: ${parsed.error.message}`,
    )
  }
  return parsed.data.results.map((result) => (result.vulns ?? []).map((vuln) => vuln.id))
}

async function fetchVulnerability(id: string, client: Client): Promise<Vulnerability> {
  const response = await fetchWithRetries(
    `${client.baseUrl}/v1/vulns/${encodeURIComponent(id)}`,
    "GET",
    undefined,
    client,
  )
  const parsed = vulnerabilityResponse.safeParse(await readJson(response, `vulnerability ${id}`))
  if (!parsed.success) {
    throw new OsvUnavailableError(
      `the OSV vulnerability ${id} response was not the expected shape: ${parsed.error.message}`,
    )
  }
  return parsed.data
}

/**
 * One request, with bounded retries. Retried: a network error, a 429 and a 5xx. Not retried: any
 * other non-2xx. Everything that survives the retries is `unavailable`.
 */
async function fetchWithRetries(
  url: string,
  method: "GET" | "POST",
  body: string | undefined,
  client: Client,
): Promise<Response> {
  let lastError = `${method} ${url} was never attempted`
  for (let attempt = 0; attempt <= client.retries; attempt += 1) {
    const controller = new AbortController()
    // Cleared in the `finally`, so a request that answered in 10 ms leaves no 30-second timer
    // behind holding the process open.
    const timer = setTimeout(() => controller.abort(), client.timeoutMs)
    try {
      const response = await client.fetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body,
        signal: controller.signal,
      })
      if (response.ok) return response
      const status = response.status
      if (status !== 429 && status < 500) {
        throw new OsvUnavailableError(`${method} ${url} answered HTTP ${status}`)
      }
      lastError = `${method} ${url} answered HTTP ${status}`
    } catch (error) {
      if (error instanceof OsvUnavailableError) throw error
      lastError = `${method} ${url} failed: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      clearTimeout(timer)
    }
    if (attempt < client.retries) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** attempt))
    }
  }
  throw new OsvUnavailableError(`${lastError} — after ${client.retries + 1} attempts`)
}

async function readJson(response: Response, what: string): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new OsvUnavailableError(`the OSV ${what} response was not JSON: ${reason}`)
  }
}

function toFinding(id: string, target: ResolvedPackage, detail: Vulnerability): AdvisoryFinding {
  return {
    id,
    package: target.name,
    version: target.version,
    severity: severityOf(detail),
    summary: summaryOf(detail),
    fixed: fixedVersionOf(detail, target),
    url: `https://osv.dev/vulnerability/${id}`,
  }
}

/** The severity the database records; the conservative label when it records none. */
function severityOf(detail: Vulnerability): string {
  const recorded = detail.database_specific?.severity
  const normalized = typeof recorded === "string" ? recorded.toUpperCase() : ""
  if (normalized === "MEDIUM") return "MODERATE"
  if (["CRITICAL", "HIGH", "MODERATE", "LOW"].includes(normalized)) return normalized
  return "HIGH"
}

/** The first line of the summary, or of the details when there is no summary. */
function summaryOf(detail: Vulnerability): string {
  const text = detail.summary ?? detail.details ?? ""
  const first = text.split("\n").find((candidate) => candidate.trim() !== "")
  const line = first?.trim() ?? ""
  if (line === "") return "No summary recorded by the advisory database."
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line
}

/**
 * The version that fixes the advisory for the resolved version.
 *
 * One advisory against a package resolved at two versions carries two different fixes; the one that
 * applies is the nearest upgrade above the resolved version.
 */
function fixedVersionOf(detail: Vulnerability, target: ResolvedPackage): string | null {
  const fixes: string[] = []
  for (const affected of detail.affected ?? []) {
    if (affected.package.name !== target.name) continue
    for (const range of affected.ranges ?? []) {
      // A GIT range carries commits, not versions: its events are hashes.
      if (range.type === "GIT") continue
      for (const event of range.events ?? []) {
        if (event.fixed !== undefined) fixes.push(event.fixed)
      }
    }
  }
  const above = fixes.filter((fix) => compareVersions(fix, target.version) > 0)
  const candidates = above.length > 0 ? above : fixes
  return candidates.sort((left, right) => compareVersions(left, right))[0] ?? null
}

/** Numeric dotted-version comparison; a segment that is not a number counts as zero. */
function compareVersions(left: string, right: string): number {
  const a = left.split(".")
  const b = right.split(".")
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = Number.parseInt(a[index] ?? "0", 10) || 0
    const y = Number.parseInt(b[index] ?? "0", 10) || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
