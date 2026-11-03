import { describe, expect, test } from "bun:test"
import type { ResolvedPackage } from "../../../advisory/lockfile"
import { assess, ECOSYSTEM, MAX_QUERIES_PER_REQUEST } from "../../../advisory/osv"

/**
 * The OSV client, against an injected fetch.
 *
 * No network, no real advisory, no real package: the fixture answers with a made-up advisory id
 * for a made-up package. What is under test is the rule that decides the three outcomes — a
 * response that cannot be understood is `unavailable`, never `clean`.
 */

const PACKAGE: ResolvedPackage = { name: "synthetic-advisory-fixture", version: "1.0.0" }
const ADVISORY_ID = "SYNTHETIC-ADVISORY-0001"

interface Fake {
  readonly fetch: typeof fetch
  readonly calls: readonly string[]
  readonly bodies: readonly string[]
}

/** A fetch that answers from a handler and records what it was asked. */
function fakeFetch(handler: (url: string, body: string | undefined) => Response): Fake {
  const calls: string[] = []
  const bodies: string[] = []
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    const body = typeof init?.body === "string" ? init.body : undefined
    bodies.push(body ?? "")
    return handler(url, body)
  }) as typeof fetch
  return { fetch: impl, calls, bodies }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const ADVISORY = {
  id: ADVISORY_ID,
  summary: "Synthetic fixture advisory",
  database_specific: { severity: "HIGH" },
  affected: [
    {
      package: { ecosystem: "npm", name: PACKAGE.name },
      ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.0.0" }] }],
    },
  ],
}

describe("a completed assessment", () => {
  test("reports clean when the database names no advisory", async () => {
    const fake = fakeFetch(() => json({ results: [{}] }))

    const assessment = await assess([PACKAGE], { fetch: fake.fetch, retries: 0 })

    expect(assessment.status).toBe("clean")
    expect(assessment.findings).toEqual([])
    expect(assessment.error).toBeNull()
    expect(assessment.packagesAssessed).toBe(1)
  })

  test("reports the advisory, its package and its version when there is one", async () => {
    const fake = fakeFetch((url) => {
      if (url.endsWith("/v1/querybatch"))
        return json({ results: [{ vulns: [{ id: ADVISORY_ID }] }] })
      return json(ADVISORY)
    })

    const assessment = await assess([PACKAGE], { fetch: fake.fetch, retries: 0 })

    expect(assessment.status).toBe("finding")
    expect(assessment.findings).toHaveLength(1)
    expect(assessment.findings[0]?.id).toBe(ADVISORY_ID)
    expect(assessment.findings[0]?.package).toBe(PACKAGE.name)
    expect(assessment.findings[0]?.version).toBe(PACKAGE.version)
    expect(assessment.findings[0]?.severity).toBe("HIGH")
    expect(assessment.findings[0]?.fixed).toBe("2.0.0")
    expect(assessment.findings[0]?.url).toBe(`https://osv.dev/vulnerability/${ADVISORY_ID}`)
  })

  test("names the version that fixes the advisory for the resolved version", async () => {
    // One advisory, one package, two affected ranges: OSV records a fix per release line, and the
    // one that applies is the line the resolved version is on. A GIT range carries commits rather
    // than versions, so its events are not versions to upgrade to.
    const fake = fakeFetch((url) => {
      if (url.endsWith("/v1/querybatch"))
        return json({ results: [{ vulns: [{ id: ADVISORY_ID }] }] })
      return json({
        id: ADVISORY_ID,
        summary: "Synthetic fixture advisory",
        affected: [
          {
            package: { name: PACKAGE.name },
            ranges: [{ type: "SEMVER", events: [{ introduced: "2.0.0" }, { fixed: "2.4.0" }] }],
          },
          {
            package: { name: PACKAGE.name },
            ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.20.9" }] }],
          },
          {
            package: { name: PACKAGE.name },
            ranges: [{ type: "GIT", events: [{ introduced: "0" }, { fixed: "abc123" }] }],
          },
        ],
      })
    })

    const assessment = await assess([{ name: PACKAGE.name, version: "2.3.0" }], {
      fetch: fake.fetch,
      retries: 0,
    })

    expect(assessment.status).toBe("finding")
    expect(assessment.findings[0]?.fixed).toBe("2.4.0")
  })

  test("asks about every package in the npm ecosystem", async () => {
    const fake = fakeFetch(() => json({ results: [{}] }))

    await assess([PACKAGE], { fetch: fake.fetch, retries: 0 })

    const body = fake.bodies[0] ?? ""
    expect(body).toContain(`"ecosystem":"${ECOSYSTEM}"`)
    expect(body).toContain(`"name":"${PACKAGE.name}"`)
    expect(body).toContain(`"version":"${PACKAGE.version}"`)
  })

  test("chunks the queries at OSV's own ceiling", async () => {
    const fake = fakeFetch((url, body) => {
      if (!url.endsWith("/v1/querybatch")) return json(ADVISORY)
      const queries = JSON.parse(body ?? "{}") as { queries?: unknown[] }
      return json({ results: (queries.queries ?? []).map(() => ({})) })
    })
    const packages: ResolvedPackage[] = Array.from(
      { length: MAX_QUERIES_PER_REQUEST + 1 },
      (_, index) => ({
        name: `synthetic-package-${index}`,
        version: "1.0.0",
      }),
    )

    const assessment = await assess(packages, { fetch: fake.fetch, retries: 0 })

    expect(assessment.status).toBe("clean")
    expect(fake.calls).toHaveLength(2)
    const sizes = fake.bodies.map(
      (body) => (JSON.parse(body) as { queries: unknown[] }).queries.length,
    )
    expect(sizes).toEqual([MAX_QUERIES_PER_REQUEST, 1])
  })
})

describe("an assessment that could not complete", () => {
  const cases: readonly (readonly [string, () => Response])[] = [
    ["a 500", () => new Response("upstream failure", { status: 500 })],
    ["an unparsable body", () => new Response("not json at all", { status: 200 })],
    ["a result count that does not match the query count", () => json({ results: [] })],
    [
      "a response that is not the expected shape",
      () => json({ results: [{ vulns: [{ id: 42 }] }] }),
    ],
  ]

  for (const [what, answer] of cases) {
    test(`${what} is unavailable, never clean`, async () => {
      const fake = fakeFetch(() => answer())

      const assessment = await assess([PACKAGE], { fetch: fake.fetch, retries: 0 })

      expect(assessment.status).toBe("unavailable")
      expect(assessment.status).not.toBe("clean")
      expect(assessment.error).not.toBeNull()
      expect(assessment.findings).toEqual([])
    })
  }

  test("a network error is unavailable, never clean", async () => {
    // The handler throws where the network would: the request rejects before any response.
    const fake = fakeFetch(() => {
      throw new Error("ECONNREFUSED")
    })

    const assessment = await assess([PACKAGE], { fetch: fake.fetch, retries: 0 })

    expect(assessment.status).toBe("unavailable")
    expect(assessment.error).toContain("ECONNREFUSED")
  })

  test("a 500 is retried before it is given up on", async () => {
    const fake = fakeFetch(() => new Response("upstream failure", { status: 500 }))

    await assess([PACKAGE], { fetch: fake.fetch, retries: 1 })

    // The first attempt plus one retry: the assessment gives the database a second chance before
    // it calls the outcome unknown.
    expect(fake.calls).toHaveLength(2)
  })

  test("a 404 is not retried — it will not become a 200", async () => {
    const fake = fakeFetch(() => new Response("no such advisory", { status: 404 }))

    const assessment = await assess([PACKAGE], { fetch: fake.fetch, retries: 3 })

    expect(assessment.status).toBe("unavailable")
    expect(fake.calls).toHaveLength(1)
  })
})
