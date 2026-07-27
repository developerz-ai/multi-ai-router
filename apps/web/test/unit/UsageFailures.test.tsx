import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import type { UsageFailureSplit } from "../../src/lib/api/usage"
import { UsageFailures } from "../../src/routes/usage/UsageFailures"

/**
 * The error rate, taken apart, rendered.
 *
 * These are claims about what an operator can read off the panel after a tool
 * errored, so they are asserted against the DOM: that "wait for a window" and
 * "go and pay" are two rows with two statuses and never one figure, that the
 * three remedies show even at zero, and that a window reaching past the rows
 * behind the counts says so before an operator draws a conclusion from them.
 *
 * `container` is queried directly and removed after, rather than `document.body`
 * — happy-dom's `document` is one global shared by every test file in this
 * process.
 */

function split(over: Partial<UsageFailureSplit> = {}): UsageFailureSplit {
  return { attempts: 0, errors: 0, partial: false, byOutcome: [], ...over }
}

function withMount(failures: UsageFailureSplit, run: (container: HTMLElement) => void): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => <UsageFailures failures={failures} windowLabel="7 days" />,
    container,
  )
  try {
    run(container)
  } finally {
    dispose()
    container.remove()
  }
}

describe("UsageFailures", () => {
  test("rate limited and out of credits are two rows with two statuses", () => {
    withMount(
      split({
        attempts: 100,
        errors: 10,
        byOutcome: [
          { outcome: "quota_exhausted", attempts: 7 },
          { outcome: "credits_exhausted", attempts: 3 },
        ],
      }),
      (container) => {
        const rows = [...container.querySelectorAll("li")].map((li) => li.textContent ?? "")
        const rateLimited = rows.find((row) => row.includes("Rate limited")) ?? ""
        const outOfCredits = rows.find((row) => row.includes("Out of credits")) ?? ""

        expect(rateLimited).toContain("429")
        expect(rateLimited).toContain("7")
        expect(outOfCredits).toContain("402")
        expect(outOfCredits).toContain("3")
        // The distinction non-negotiable 7 exists for, in the words an operator acts on.
        expect(rateLimited).toContain("comes back on its own")
        expect(outOfCredits).toContain("top-up")
      },
    )
  })

  test("shows the three remedies even when nothing failed", () => {
    withMount(split({ attempts: 500 }), (container) => {
      // "Nothing was rate limited" is an answer. An absent row is a question.
      expect(container.textContent).toContain("Rate limited")
      expect(container.textContent).toContain("Out of credits")
      expect(container.textContent).toContain("Out of scope")
      expect(container.querySelectorAll("li")).toHaveLength(3)
    })
  })

  test("says the counts are a floor when the window outruns the rows behind them", () => {
    withMount(split({ attempts: 40, errors: 4, partial: true, byOutcome: [] }), (container) => {
      expect(container.textContent).toContain("at least this many")
    })
  })

  test("says nothing about a floor when the scan covered the whole window", () => {
    withMount(split({ attempts: 40, errors: 0 }), (container) => {
      expect(container.textContent).not.toContain("at least this many")
    })
  })

  test("names the outcomes inside a class that has more than one", () => {
    withMount(
      split({
        attempts: 50,
        errors: 13,
        byOutcome: [
          { outcome: "upstream_timeout", attempts: 9 },
          { outcome: "upstream_error", attempts: 4 },
        ],
      }),
      (container) => {
        const row =
          [...container.querySelectorAll("li")]
            .map((li) => li.textContent ?? "")
            .find((text) => text.includes("Upstream failed")) ?? ""

        expect(row).toContain("13")
        // "Which upstream failure" is the follow-up question, answered on the row.
        expect(row).toContain("upstream timeout")
        expect(row).toContain("upstream error")
      },
    )
  })

  test("a class made of one outcome does not repeat itself", () => {
    withMount(
      split({
        attempts: 50,
        errors: 2,
        byOutcome: [{ outcome: "scope_violation", attempts: 2 }],
      }),
      (container) => {
        expect(container.textContent).toContain("Out of scope")
        expect(container.textContent).not.toContain("scope violation")
      },
    )
  })

  test("draws each share against the scan's own denominator", () => {
    withMount(
      split({
        attempts: 200,
        errors: 50,
        byOutcome: [{ outcome: "quota_exhausted", attempts: 50 }],
      }),
      (container) => {
        expect(container.textContent).toContain("25.0% of attempts")
      },
    )
  })

  test("colour is never the only carrier — every row spells out its class and status", () => {
    withMount(
      split({
        attempts: 10,
        errors: 1,
        byOutcome: [{ outcome: "router_error", attempts: 1 }],
      }),
      (container) => {
        const dots = container.querySelectorAll('[aria-hidden="true"]')

        expect(dots.length).toBeGreaterThan(0)
        for (const dot of dots) expect(dot.textContent).toBe("")
        expect(container.textContent).toContain("Router fault")
        expect(container.textContent).toContain("500")
      },
    )
  })

  test("a class with several real statuses says so rather than inventing one", () => {
    withMount(
      split({
        attempts: 10,
        errors: 2,
        byOutcome: [
          { outcome: "client_error", attempts: 1 },
          { outcome: "request_too_large", attempts: 1 },
        ],
      }),
      (container) => {
        expect(container.textContent).toContain("various statuses")
      },
    )
  })

  test("names the window, so the counts are never read against the wrong range", () => {
    withMount(split({ attempts: 3, errors: 1 }), (container) => {
      expect(container.textContent).toContain("7 days")
    })
  })

  test("is a labelled landmark, so it is reachable without reading down the page", () => {
    withMount(split(), (container) => {
      const section = container.querySelector("section")
      const heading = container.querySelector("h2")

      expect(heading?.textContent).toBe("Why requests failed")
      expect(section?.getAttribute("aria-labelledby")).toBe(heading?.id)
    })
  })
})
