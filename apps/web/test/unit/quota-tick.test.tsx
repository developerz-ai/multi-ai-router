import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ResetIndicator } from "../../src/components/ResetIndicator"
import type { QuotaWindowView } from "../../src/lib/api/types"
import { formatAbsolute } from "../../src/lib/format"

/**
 * `/accounts` ticks once a second over every window of every account, so what one tick costs is
 * multiplied by the fleet. Building a date formatter costs ~140 µs and an instant that did not
 * move needs no formatting at all.
 */
test("a clock tick reads each window once and never reformats an unchanged instant", () => {
  const start = Date.parse("2026-11-23T00:00:00Z")
  let instantReads = 0
  const windows = [
    {
      window: "five_hour",
      utilization: 0.5,
      utilizationSource: "gauge",
      resetSource: "provider-reported",
      lastCheckedAt: "2026-11-23T00:00:00Z",
      spent: false,
      tokensUsed: null,
      tokenLimit: null,
      get resetsAt() {
        instantReads += 1
        return "2026-11-23T03:00:00Z"
      },
    } as QuotaWindowView,
  ]
  const root = document.createElement("div")
  const [now, setNow] = createSignal(start)
  const dispose = render(
    () => (
      <ResetIndicator
        label="acc"
        nowMs={now()}
        quotaWindows={windows}
        resetSource="unknown"
        resetsAt={null}
        status="active"
      />
    ),
    root,
  )
  try {
    expect(root.textContent).toContain("in 3h")
    const before = instantReads
    const absolute = root.querySelector('[class="absolute"]')?.firstChild
    setNow(start + 1_000)
    expect(root.textContent).toContain("in 2h 59m")
    expect(instantReads - before).toBe(1)
    expect(root.querySelector('[class="absolute"]')?.firstChild === absolute).toBe(true)
  } finally {
    dispose()
  }
})

test("formatting an instant reuses one formatter per locale", () => {
  const native = Intl.DateTimeFormat
  formatAbsolute(0, "en-GB")
  let built = 0
  Intl.DateTimeFormat = new Proxy(native, {
    construct(target, args) {
      built += 1
      return Reflect.construct(target, args)
    },
  })
  const nativeToLocale = Date.prototype.toLocaleString
  Date.prototype.toLocaleString = function (...args) {
    built += 1
    return nativeToLocale.apply(this, args as [])
  }
  try {
    for (let i = 0; i < 10; i += 1) formatAbsolute(i * 60_000, "en-GB")
    expect(built).toBe(0)
  } finally {
    Intl.DateTimeFormat = native
    Date.prototype.toLocaleString = nativeToLocale
  }
})
