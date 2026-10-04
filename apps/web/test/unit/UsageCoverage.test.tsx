import { expect, test } from "bun:test"
import { render } from "solid-js/web"
import { UsageChart } from "../../src/routes/usage/UsageChart"
import { UsageCoverage } from "../../src/routes/usage/UsageCoverage"
import { usageCoverage } from "../support/usage-coverage"

test("history and retained-detail caveats identify their own denominator and precision", () => {
  const coverage = {
    ...usageCoverage(2),
    legacy: true,
    incomplete: true,
    bucketWidth: 7,
    retainedDetail: {
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-03T00:00:00.000Z",
      attempts: 2,
      totalAttempts: 20,
      partial: true,
    },
    breakdown: { maxRows: 1, truncated: ["accountId"] },
  }
  const node = document.createElement("div")
  document.body.append(node)
  const dispose = render(() => <UsageCoverage summary={{ coverage, bucket: "day" }} />, node)
  try {
    const text = node.textContent ?? ""
    expect(text).toContain("7 days per chart point")
    expect(text).toContain("2 retained attempts")
    expect(text).toContain("Legacy daily history is preserved")
    expect(text).toContain("Missing evidence is not zero traffic")
    expect(text).toContain("historical denominator is incomplete")
    expect(text).toContain("Detail covers 2026-10-01")
    expect(text).toContain("at most 1 rows")
  } finally {
    dispose()
    node.remove()
  }
})

test("an incomplete zero chart does not claim that no traffic occurred", () => {
  for (const incomplete of [true, false]) {
    const node = document.createElement("div")
    document.body.append(node)
    const dispose = render(
      () => (
        <UsageChart
          bucket="hour"
          incomplete={incomplete}
          points={[{ at: "2026-10-03T00:00:00Z", requests: 0, attempts: 0, errors: 0 }]}
        />
      ),
      node,
    )
    try {
      if (incomplete) {
        expect(node.textContent).toContain("historical evidence is unavailable")
        expect(node.textContent).not.toContain("No traffic")
      } else {
        expect(node.textContent).toContain("No traffic in this window")
        expect(node.textContent).not.toContain("historical evidence is unavailable")
      }
    } finally {
      dispose()
      node.remove()
    }
  }
})

test("pending detail never renders one retained attempt as part of a zero historical total", () => {
  const coverage = {
    ...usageCoverage(1),
    incomplete: true,
    retainedDetail: { ...usageCoverage(1).retainedDetail, totalAttempts: 0, partial: true },
  }
  const node = document.createElement("div")
  document.body.append(node)
  const dispose = render(() => <UsageCoverage summary={{ coverage, bucket: "day" }} />, node)
  try {
    const text = node.textContent ?? ""
    expect(text).toContain("1 retained attempt")
    expect(text).toContain("historical denominator is incomplete")
    expect(text).toContain("0 attempts are currently accounted for")
    expect(text).not.toContain("1 retained attempt of 0")
  } finally {
    dispose()
    node.remove()
  }
})
