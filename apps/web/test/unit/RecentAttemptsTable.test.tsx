import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import type { RecentAttempt } from "../../src/lib/api/usage-recent"
import { RecentAttemptsTable } from "../../src/routes/usage/RecentAttemptsTable"
import { emptyFor } from "../../src/routes/usage/UsageRecent"

/**
 * The live feed's table, rendered.
 *
 * These are claims about what an operator can actually read off a row, so they are asserted
 * against the DOM rather than against a helper: a failover chain shows as several rows, an
 * upstream that was never reached says so instead of showing a status, an outcome is always spelt
 * out beside its dot, and a subject that no longer exists is still named.
 *
 * `container` is queried directly and removed after, rather than `document.body` — happy-dom's
 * `document` is one global shared by every test file in this process.
 */

const NOW_MS = Date.parse("2026-07-26T00:10:00.000Z")

function attempt(over: Partial<RecentAttempt> = {}): RecentAttempt {
  return {
    id: "row-1",
    correlationId: "11111111-1111-4111-8111-111111111111",
    clientRequestId: null,
    attempt: 1,
    key: { id: "key-1", label: "dev-laptops", note: null },
    account: { id: "acct-1", label: "claude-max-01", note: null },
    pool: { id: null, label: null, note: "none" },
    provider: "anthropic",
    model: "claude-sonnet-5",
    upstreamModel: "claude-sonnet-5",
    ingressDialect: "anthropic",
    egressMode: "passthrough",
    outcome: "success",
    fault: "none",
    httpStatus: 200,
    errorClass: null,
    latencyMs: 812,
    ttfbMs: 91,
    routerOverheadMs: 2,
    streamed: true,
    tokensIn: 1200,
    tokensOut: 340,
    at: "2026-07-26T00:00:00.000Z",
    ...over,
  }
}

function withMount(
  attempts: readonly RecentAttempt[],
  run: (container: HTMLElement) => void,
): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => <RecentAttemptsTable attempts={attempts} limit={50} nowMs={NOW_MS} />,
    container,
  )
  try {
    run(container)
  } finally {
    dispose()
    container.remove()
  }
}

describe("RecentAttemptsTable", () => {
  test("a failover chain reads as several attempts under one request id", () => {
    withMount(
      [
        attempt({ id: "row-2", attempt: 2, outcome: "success" }),
        attempt({
          id: "row-1",
          attempt: 1,
          outcome: "quota_exhausted",
          fault: "capacity",
          account: { id: "acct-2", label: "claude-max-02", note: null },
        }),
      ],
      (container) => {
        // Merging them would hide exactly the failover the router exists to perform.
        expect(container.querySelectorAll("tbody tr")).toHaveLength(2)
        expect(container.textContent).toContain("attempt 1")
        expect(container.textContent).toContain("attempt 2")
        expect(container.textContent).toContain("claude-max-01")
        expect(container.textContent).toContain("claude-max-02")
      },
    )
  })

  test("an outcome is written in words, never carried by the dot alone", () => {
    withMount([attempt({ outcome: "credits_exhausted", fault: "capacity" })], (container) => {
      expect(container.textContent).toContain("credits exhausted")
      // Whose problem it is, said out loud beside the colour.
      expect(container.textContent).toContain("Capacity")
      const dot = container.querySelector('span[aria-hidden="true"][style*="--dot-color"]')
      expect(dot).not.toBeNull()
    })
  })

  test("quota and credits exhaustion never render as the same words", () => {
    withMount(
      [attempt({ id: "a", outcome: "quota_exhausted", fault: "capacity" })],
      (container) => {
        expect(container.textContent).toContain("quota exhausted")
        expect(container.textContent).not.toContain("credits exhausted")
      },
    )
  })

  test("an attempt that never reached an upstream says so instead of showing a status", () => {
    withMount(
      [
        attempt({
          outcome: "no_healthy_account",
          fault: "capacity",
          httpStatus: null,
          errorClass: "NoHealthyAccountError",
          ttfbMs: null,
          streamed: false,
          account: { id: null, label: null, note: "none" },
        }),
      ],
      (container) => {
        // "never reached" and a 200 are different facts and must not read alike.
        expect(container.textContent).toContain("never reached")
        expect(container.textContent).toContain("NoHealthyAccountError")
        // No byte was relayed, so there is no time to first byte. Not a zero.
        expect(container.textContent).toContain("no first byte")
      },
    )
  })

  test("a subject that no longer exists is named as deleted, never left blank", () => {
    withMount([attempt({ key: { id: "key-gone", label: null, note: "deleted" } })], (container) => {
      // Usage rows outlive the keys they name; hiding the row would hide the failure.
      expect(container.textContent).toContain("(deleted)")
    })
  })

  test("a model rewritten by an alias map shows both names", () => {
    withMount([attempt({ model: "claude-sonnet-5", upstreamModel: "glm-4.7" })], (container) => {
      expect(container.textContent).toContain("claude-sonnet-5")
      expect(container.textContent).toContain("sent as glm-4.7")
    })
  })

  test("a model that was not aliased says it once, not twice", () => {
    withMount([attempt()], (container) => {
      expect(container.textContent).not.toContain("sent as")
    })
  })

  test("shows eight columns and no token counts — the summary already counts tokens", () => {
    withMount([attempt()], (container) => {
      const headers = [...container.querySelectorAll("thead th")].map((node) => node.textContent)
      expect(headers).toEqual([
        "When",
        "Outcome",
        "Status / error",
        "Request",
        "Account / key",
        "Model",
        "Latency",
        "Path",
      ])
    })
  })

  test("names the account and the key that asked, in one column", () => {
    withMount([attempt()], (container) => {
      expect(container.textContent).toContain("claude-max-01")
      expect(container.textContent).toContain("dev-laptops")
    })
  })

  test("router overhead and first byte ride beside attempt latency, never instead of it", () => {
    withMount([attempt()], (container) => {
      // Latency is dominated by generation; the other two are what a budget is read off.
      expect(container.textContent).toContain("812 ms")
      expect(container.textContent).toContain("+2 ms router")
      expect(container.textContent).toContain("91 ms ttfb")
    })
  })

  test("says the two latency figures do not share a start", () => {
    withMount([attempt({ latencyMs: 17, ttfbMs: 25, attempt: 2 })], (container) => {
      // A later attempt's latency can be *smaller* than the request's TTFB, because one is
      // measured from the attempt and the other from the request. Unlabelled, that reads as broken.
      const hint = [...container.querySelectorAll("[title]")].map((node) =>
        node.getAttribute("title"),
      )
      expect(hint.join(" ")).toContain("from the request entering the router")
      expect(hint.join(" ")).toContain("this attempt alone")
    })
  })

  test("the caption says a row is an attempt and that no body is stored", () => {
    withMount([attempt()], (container) => {
      const caption = container.querySelector("caption")?.textContent ?? ""
      expect(caption).toContain("at most 50")
      expect(caption).toContain("not one client request")
      expect(caption).toContain("never by message")
    })
  })

  test("carries the request ids an operator can search on", () => {
    withMount([attempt({ clientRequestId: "req-42" })], (container) => {
      // Shortened in the cell, whole in the tooltip — an id is never silently truncated.
      expect(container.textContent).toContain("11111111")
      expect(container.textContent).toContain("req-42")
      expect(container.innerHTML).toContain("11111111-1111-4111-8111-111111111111")
    })
  })
})

describe("the empty state", () => {
  test("an unrouted router is told what will land here, not 'no results'", () => {
    expect(emptyFor("all", "").title).toBe("Nothing has been routed yet")
    expect(emptyFor("all", "").description).toContain("/v1")
  })

  test("a request id that matches nothing blames retention, not the operator", () => {
    expect(emptyFor("all", "req-42").title).toContain("request id")
    expect(emptyFor("all", "req-42").description).toContain("retention window")
  })

  test("a filter that matches nothing names the filter and the way out", () => {
    const state = emptyFor("credits_exhausted", "")
    expect(state.title).toBe("Nothing matches that filter")
    expect(state.description).toContain("credits exhausted")
    expect(state.description).toContain("Everything")
  })
})
