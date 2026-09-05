import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { NO_USAGE, type UsageRowSummary } from "../../src/lib/usage-index"
import { TrafficCell } from "../../src/routes/accounts/TrafficCell"

function withMount(
  props: { readonly usage: UsageRowSummary; readonly loading?: boolean },
  run: (container: HTMLElement) => void,
): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => (
      <TrafficCell
        bucket="day"
        label="Requests per day for account a"
        loading={props.loading}
        usage={props.usage}
      />
    ),
    container,
  )
  try {
    run(container)
  } finally {
    dispose()
    container.remove()
  }
}

describe("TrafficCell", () => {
  test("pending is a dash, never a zero", () => {
    withMount({ usage: NO_USAGE, loading: true }, (container) => {
      expect(container.textContent).toContain("—")
      expect(container.textContent).not.toContain("0")
    })
  })

  test("a silent row reads 'no traffic' rather than a sparkline of nothing beside two $0.00s", () => {
    withMount({ usage: NO_USAGE }, (container) => {
      expect(container.textContent).toContain("no traffic")
      expect(container.textContent).not.toContain("$0.00")
    })
  })

  test("a served row shows the count and both spend figures, labelled apart", () => {
    withMount(
      {
        usage: {
          ...NO_USAGE,
          requests: 81,
          costMetered: 0.5,
          costNotional: 12.4,
          series: [1, 2, 3],
        },
      },
      (container) => {
        expect(container.textContent).toContain("81")
        expect(container.textContent).toContain("$0.50")
        expect(container.textContent).toContain("$12.40 notional")
        expect(container.querySelector('[title^="Metered"]')).not.toBeNull()
      },
    )
  })
})
