import { describe, expect, test } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import { request } from "../../src/lib/api/client"
import { ApiError } from "../../src/lib/api/errors"
import { clearSession } from "../../src/lib/api/session"
import { QUERY_DEFAULTS, shouldRetryQuery } from "../../src/lib/query"

/**
 * The console's read defaults. A `4xx` answers the same the second time — and a `401` is a
 * session event whose redirect a retry only delays — so only a `5xx` or a transport failure is
 * worth one more try.
 */

const parsed = { message: "no", type: null, code: null }

describe("shouldRetryQuery", () => {
  test("never retries a 4xx", () => {
    for (const status of [400, 401, 403, 404, 409]) {
      expect(shouldRetryQuery(0, new ApiError(status, parsed))).toBe(false)
    }
  })

  test("retries a 5xx or a transport failure once", () => {
    expect(shouldRetryQuery(0, new ApiError(502, parsed))).toBe(true)
    expect(shouldRetryQuery(0, new TypeError("network"))).toBe(true)
    expect(shouldRetryQuery(1, new ApiError(502, parsed))).toBe(false)
  })
})

async function callsFor(status: number): Promise<number> {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return Response.json({ error: { message: "refused" } }, { status })
  }) as unknown as typeof fetch
  const client = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retryDelay: 0 } },
  })
  const observer = new QueryObserver(client, {
    queryKey: ["probe", status],
    queryFn: () => request({ method: "GET", path: "/accounts" }),
  })
  try {
    await new Promise<void>((resolve) => {
      const unsubscribe = observer.subscribe((result) => {
        if (result.isError) {
          unsubscribe()
          resolve()
        }
      })
    })
    return calls
  } finally {
    globalThis.fetch = originalFetch
    client.clear()
    clearSession()
  }
}

describe("a read under the console defaults", () => {
  test("a 403 is fetched once", async () => {
    expect(await callsFor(403)).toBe(1)
  })

  test("a 502 is fetched twice", async () => {
    expect(await callsFor(502)).toBe(2)
  })
})
