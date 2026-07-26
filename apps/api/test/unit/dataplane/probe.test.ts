import { describe, expect, test } from "bun:test"
import { admitHalfOpenProbe, type ProbeAdmission } from "../../../src/services/dataplane"
import { candidate, NOW, account as routingAccount } from "../routing/fixtures"

/**
 * The chain-facing side of the gate: which candidates are gated at all, and who owes a release.
 *
 * The rule the release half protects is subtle and load-bearing: a caller that never took a hold
 * must never release one, or a request admitted because the account had already recovered would
 * free the hold a *different* request is currently probing under.
 */

function gate(admission: ProbeAdmission) {
  const calls: string[] = []
  const health = {
    admitProbe: (accountId: string) => {
      calls.push(`admit:${accountId}`)
      return admission
    },
    releaseProbe: (accountId: string) => void calls.push(`release:${accountId}`),
  }
  return { health, calls }
}

const probe = candidate(routingAccount("a"), 0, { halfOpen: true })
const healthy = candidate(routingAccount("a"))

describe("admitHalfOpenProbe", () => {
  test("a healthy candidate is never gated — the store is not even asked", () => {
    const { health, calls } = gate({ admitted: true, held: true })
    const verdict = admitHalfOpenProbe(health, healthy, NOW)

    expect(verdict.admitted).toBe(true)
    expect(calls).toEqual([])
  })

  test("an admitted probe releases the hold it took", () => {
    const { health, calls } = gate({ admitted: true, held: true })
    admitHalfOpenProbe(health, probe, NOW).release()

    expect(calls).toEqual(["admit:a", "release:a"])
  })

  test("a probe admitted without a hold releases nothing — it owns nothing to release", () => {
    const { health, calls } = gate({ admitted: true, held: false })
    const verdict = admitHalfOpenProbe(health, probe, NOW)
    verdict.release()

    expect(verdict.admitted).toBe(true)
    expect(calls).toEqual(["admit:a"])
  })

  test("a refused probe releases nothing: the hold belongs to another request", () => {
    const { health, calls } = gate({ admitted: false, held: false })
    const verdict = admitHalfOpenProbe(health, probe, NOW)
    verdict.release()

    expect(verdict.admitted).toBe(false)
    expect(calls).toEqual(["admit:a"])
  })
})
