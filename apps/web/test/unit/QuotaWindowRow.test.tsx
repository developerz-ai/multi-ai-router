import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ResetIndicator } from "../../src/components/ResetIndicator"
import type { QuotaWindowView } from "../../src/lib/api/types"

/**
 * `/accounts` ticks once a second. Only each window's reset half — the countdown and the instant
 * beside it — depends on the clock; the gauge, notes and sparkline series depend on the window's
 * data. A tick must reach the countdown and leave the rest alone: before the split, every window
 * on the screen was redescribed and every sparkline path rebuilt each second.
 */
test("a clock tick updates the countdown without redescribing the window or its series", () => {
  let seriesReads = 0
  const series = new Proxy([10, 20, 30], {
    get(target, key, receiver) {
      if (key === "length") seriesReads++
      return Reflect.get(target, key, receiver)
    },
  })
  const start = Date.parse("2026-11-11T10:00:00.000Z")
  const window: QuotaWindowView = {
    window: "five_hour",
    utilization: null,
    utilizationSource: "none",
    resetsAt: new Date(start + 2 * 3_600_000).toISOString(),
    resetSource: "provider-reported",
    lastCheckedAt: new Date(start).toISOString(),
    spent: false,
    tokensUsed: 500,
    tokenLimit: 1_000,
    tokenSeries: series,
  }
  const [nowMs, setNowMs] = createSignal(start)
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => (
      <ResetIndicator
        label="acc"
        nowMs={nowMs()}
        quotaWindows={[window]}
        resetSource="provider-reported"
        resetsAt={null}
        status="active"
      />
    ),
    container,
  )
  try {
    const row = container.querySelector("li")
    expect(container.textContent).toContain("in 2h")
    const before = seriesReads

    setNowMs(start + 61 * 60_000)

    expect(container.querySelector("li") === row).toBe(true)
    expect(container.textContent).toContain("in 59m")
    expect(seriesReads).toBe(before)
  } finally {
    dispose()
    container.remove()
  }
})
