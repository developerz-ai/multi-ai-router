import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { AccountView } from "../../src/lib/api/types"
import { UsageQuota } from "../../src/routes/usage/UsageQuota"

// The quota section re-renders on a 30-second clock. The regression pinned here: deriving the
// per-account entries from `nowMs` inside the `<For>`'s source made every tick produce new object
// identities, so the reference-keyed `<For>` disposed and recreated every account block — open
// tooltips vanished mid-read and screen-reader position was lost. Identity must survive a tick;
// only the text inside may change.

const NOW = Date.parse("2026-07-26T00:00:00.000Z")

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: "acc-1",
    label: "claude-max-1",
    provider: "anthropic-oauth",
    status: "active",
    hasCredential: false,
    configDir: "/data/claude/one",
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    weight: 1,
    priority: 0,
    billing: "subscription",
    tokenExpiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    availability: {
      configuredStatus: "active",
      resetsAt: null,
      resetSource: "unknown",
      lastCheckedAt: null,
      consecutiveFailures: 0,
      inFlight: 0,
      quotaWindows: [
        {
          window: "five_hour",
          utilization: 0.62,
          utilizationSource: "threshold-triggered",
          resetsAt: "2026-07-26T01:00:00.000Z",
          resetSource: "provider-reported",
          lastCheckedAt: "2026-07-25T23:59:00.000Z",
          spent: false,
          tokensUsed: null,
          tokenLimit: null,
        },
      ],
    },
    ...overrides,
  }
}

describe("UsageQuota", () => {
  test("a clock tick updates rows in place — it never disposes and recreates the account block", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const [nowMs, setNowMs] = createSignal(NOW)
    const accounts = [account()]

    const dispose = render(
      () => <UsageQuota accounts={accounts} failed={false} nowMs={nowMs()} />,
      container,
    )
    try {
      const before = container.querySelector("li")
      expect(before).not.toBeNull()
      const textBefore = before?.textContent ?? ""
      expect(textBefore).toContain("claude-max-1")

      setNowMs(NOW + 30_000)

      const after = container.querySelector("li")
      // Same DOM node, not an equal-looking replacement: identity is what keeps an open tooltip
      // and the screen reader's position alive across the tick.
      expect(after).toBe(before as never)
      // And the tick still did its job — the countdown text moved.
      expect(after?.textContent).not.toBe(textBefore)
    } finally {
      dispose()
      container.remove()
    }
  })

  test("an account with no windows renders no block, and a failed read says so", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const bare = account({ availability: undefined })
    const dispose = render(
      () => <UsageQuota accounts={[bare]} failed={true} nowMs={NOW} />,
      container,
    )
    try {
      expect(container.querySelectorAll("li").length).toBe(0)
      expect(container.textContent).toContain("failed read")
    } finally {
      dispose()
      container.remove()
    }
  })
})
