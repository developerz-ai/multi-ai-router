import { expect, test } from "bun:test"
import type { RecoveryAccess } from "../../../src/services/dataplane/recovery-access"
import { hintRecoveryRejections } from "../../../src/services/dataplane/recovery-hints"
import type { RejectedCandidate } from "../../../src/services/routing"
import { account as snapshot } from "../routing/fixtures"
import { NOW } from "./fixtures"

function hinted(rejected: readonly Partial<RejectedCandidate>[]) {
  const reads: string[] = []
  const hints: string[] = []
  const recovery = {
    quotaStaleAfterMs: 1_000,
    currentSnapshot: (id: string) => {
      reads.push(id)
      return snapshot(id)
    },
    hint: (id: string, reason: string) => void hints.push(`${id}:${reason}`),
  } as unknown as RecoveryAccess
  hintRecoveryRejections(rejected as readonly RejectedCandidate[], recovery, "m", NOW)
  return { reads, hints }
}

test("only a refusal a recovery can clear reads the account's snapshot", () => {
  const { reads, hints } = hinted([
    { accountId: "a", reason: "model-unsupported" },
    { accountId: "b", reason: "disabled" },
    { accountId: "c", reason: "exhausted" },
    { accountId: "d", reason: "probe-in-flight" },
    { accountId: "e", reason: "cooling-down" },
  ])
  expect(reads).toEqual(["d", "e"])
  expect(hints).toEqual(["d:cooldown-expired", "e:cooldown-expired"])
})

test("an unhinted refusal ahead of a hinted one for the same account does not hide it", () => {
  const { hints } = hinted([
    { accountId: "a", reason: "model-unsupported" },
    { accountId: "a", reason: "probe-in-flight" },
    { accountId: "a", reason: "probe-in-flight" },
  ])
  expect(hints).toEqual(["a:cooldown-expired"])
})

test("a cooldown whose reset is known is left to its clock", () => {
  expect(hinted([{ accountId: "a", reason: "cooling-down", resetsAt: NOW }]).hints).toEqual([])
})
