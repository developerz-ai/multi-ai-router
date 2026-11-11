import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { QuotaWindowRow } from "../../src/components/QuotaWindowRow"
import type { QuotaWindowDisplay } from "../../src/lib/quota-windows"

/**
 * `/accounts` ticks once a second and rebuilds every window description for its countdown. The
 * series inside is the server's own array; copying it per tick made every sparkline recompute
 * its path every second. A tick that leaves the series alone must not touch it.
 */
test("a clock tick that keeps the series reference does not re-read the series", () => {
  let reads = 0
  const series = new Proxy([10, 20, 30], {
    get(target, key, receiver) {
      if (key === "length") reads++
      return Reflect.get(target, key, receiver)
    },
  })
  const display = (text: string): QuotaWindowDisplay => ({
    window: "five_hour",
    label: "5h",
    title: "5-hour window",
    utilization: 0.5,
    utilizationText: "50%",
    utilizationSource: "measured",
    utilizationNote: "",
    utilizationQualifier: null,
    reset: { kind: "countdown", countdown: text, text, qualifier: "estimated" },
    resetsAtMs: null,
    resetLabel: "estimated",
    spent: false,
    lastCheckedAtMs: null,
    tokenSeries: series,
  })
  const [window, setWindow] = createSignal(display("in 2h 0m"))
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => <QuotaWindowRow owner="acc" window={window()} />, container)
  try {
    const before = reads
    setWindow(display("in 1h 59m"))
    expect(container.textContent).toContain("in 1h 59m")
    expect(reads).toBe(before)
  } finally {
    dispose()
    container.remove()
  }
})
