import { expect, test } from "bun:test"
import { render } from "solid-js/web"
import { FleetTiles, type FleetTilesProps } from "../../src/routes/overview/FleetTiles"

test("figures a failed refresh left behind are labelled as the last reading", () => {
  const query = (data: unknown, isError: boolean) => ({ isPending: false, isError, data }) as never
  const root = document.createElement("div")
  const props: FleetTilesProps = {
    accounts: query([], false),
    keys: query([], false),
    pools: query([], false),
    usage: query({ totals: { requests: 12, attempts: 12, errors: 0, costMetered: 0 } }, true),
    nowMs: 0,
    routableNow: 0,
    windowLabel: "today",
  }
  const dispose = render(() => <FleetTiles {...props} />, root)
  try {
    expect(root.textContent).toContain("12")
    expect(root.textContent?.match(/last reading/g)).toHaveLength(3)
  } finally {
    dispose()
  }
})
