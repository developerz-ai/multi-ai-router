import { expect, test } from "bun:test"
import {
  continuousQuotaHeadroom,
  mergeQuotaEvidence,
  type QuotaEvidence,
  toQuotaEvidence,
} from "../../../src/services/routing/quota-evidence"

const now = new Date(10000)
const known: QuotaEvidence = {
  window: "five_hour",
  utilization: 1,
  utilizationSource: "continuous",
  resetsAt: new Date(9000),
  resetSource: "provider-reported",
  lastCheckedAt: new Date(1000),
  revision: 1,
  evidenceState: "current",
  blocksRouting: true,
}
const retired: QuotaEvidence = {
  window: "five_hour",
  utilizationSource: "none",
  resetSource: "unknown",
  lastCheckedAt: new Date(1000),
  revision: 2,
  retiredAt: now,
  evidenceState: "expired",
  blocksRouting: false,
}
test("retirement defeats equal-clock old live evidence in either overlay order", () => {
  const { revision: _revision, evidenceState: _state, blocksRouting: _blocks, ...live } = known
  expect(mergeQuotaEvidence(retired, live)).toBe(retired)
  expect(mergeQuotaEvidence(live, retired)).toBe(retired)
  expect(
    continuousQuotaHeadroom({ quotaWindows: [mergeQuotaEvidence(retired, live)] }, now),
  ).toBeNull()
})
test("strictly newer provider observation removes retirement without inheriting revision", () => {
  const fresh = {
    ...known,
    lastCheckedAt: new Date(1001),
    resetsAt: new Date(20000),
    utilization: 0.1,
  }
  delete fresh.revision
  delete fresh.evidenceState
  delete fresh.blocksRouting
  const merged = mergeQuotaEvidence(retired, fresh)
  expect(merged).toBe(fresh)
  expect(merged.retiredAt).toBeUndefined()
  expect(merged.revision).toBeUndefined()
  expect(continuousQuotaHeadroom({ quotaWindows: [merged] }, now)).toBe(0.9)
})
test("durable higher revision wins same clock while local restrictive change loses revision", () => {
  expect(mergeQuotaEvidence(known, retired)).toBe(retired)
  const local = { ...known, revision: undefined, resetsAt: new Date(30000) }
  const merged = mergeQuotaEvidence(known, local)
  expect(merged.resetsAt).toEqual(new Date(30000))
  expect(merged.revision).toBeUndefined()
  expect(mergeQuotaEvidence(retired, { ...known, revision: 3 }).revision).toBe(3)
})
test("expired named and limiter facts do not rank; unknown reset remains observed capacity", () => {
  expect(
    continuousQuotaHeadroom(
      {
        quotaWindows: [known],
        limiterWindows: [{ utilization: 1, utilizationSource: "continuous", resetsAt: now }],
      },
      now,
    ),
  ).toBeNull()
  expect(continuousQuotaHeadroom({ quotaWindows: [{ ...known, resetsAt: undefined }] }, now)).toBe(
    0,
  )
})
test("catalog mapper preserves retirement and original provider observation age", () => {
  const mapped = toQuotaEvidence({
    window: "five_hour",
    utilization: null,
    utilizationSource: "none",
    resetsAt: null,
    resetSource: "unknown",
    lastCheckedAt: new Date(1000),
    revision: 2,
    retiredAt: now,
    evidenceState: "expired",
    blocksRouting: false,
  })
  expect(mapped).toEqual(retired)
})
