/**
 * Sticky placement survives a session's home account going half-open.
 *
 * An HTTP session's account is recomputed every request by rendezvous hashing over the accounts
 * that are eligible *now*. Before this, a transient `429` on the home account moved the session to
 * a cold account, the half-open demotion kept it there until some other request probed the home,
 * and the recovery-permit promotion dragged an unrelated session onto the recovering account. Each
 * hop is a full prompt-cache miss. Now: the home keeps its rank when it is merely half-open, a probe
 * that is not the session's home still ranks behind every healthy account, and the permit is spent
 * only by a session already homed there. Pure: the health snapshot is the candidate list.
 */

import { describe, expect, test } from "bun:test"
import type { PolicyInput } from "../../../src/services/routing"
import { runPolicy } from "../../../src/services/routing"
import type { Candidate } from "../../../src/services/routing/types"
import { account, candidate, health, ids, NOW } from "./fixtures"

const IDS = ["a", "b", "c", "d"] as const

function pool(overrides: Readonly<Record<string, Partial<Candidate>>> = {}): Candidate[] {
  return IDS.map((id, order) => candidate(account(id), order, overrides[id] ?? {}))
}

function input(sessionKey: string, candidates: readonly Candidate[]): PolicyInput {
  return { now: NOW, candidates, sessionKey, rotationCounter: 0, options: {} }
}

/** The session's rendezvous order with every account healthy. */
function homeOrder(sessionKey: string): readonly string[] {
  return ids(runPolicy("sticky", input(sessionKey, pool())).ordered)
}

/** A session whose home and runner-up are both known, for each scenario below. */
const SESSION = "session-affinity"
const [HOME, SECOND] = homeOrder(SESSION) as [string, string, ...string[]]

const credentialRejected = (id: string): Candidate =>
  candidate(
    account(id, {
      status: "cooling_down",
      health: health({ cooldownReason: "credential-rejected" }),
    }),
    IDS.indexOf(id as (typeof IDS)[number]),
    { halfOpen: true },
  )

describe("sticky: a half-open home keeps the session", () => {
  test("the home stays first when it is merely half-open", () => {
    const result = runPolicy("sticky", input(SESSION, pool({ [HOME]: { halfOpen: true } })))
    expect(ids(result.ordered)).toEqual([...homeOrder(SESSION)])
    expect(result.notes).toContainEqual({ kind: "affinity-kept", accountId: HOME })
    expect(result.notes.some((note) => note.kind === "half-open-demoted")).toBe(false)
  })

  test("a probe that is not this session's home still ranks behind every healthy account", () => {
    const result = runPolicy("sticky", input(SESSION, pool({ [SECOND]: { halfOpen: true } })))
    expect(result.ordered[0]?.account.id).toBe(HOME)
    expect(result.ordered.at(-1)?.account.id).toBe(SECOND)
    expect(result.notes).toContainEqual({ kind: "half-open-demoted", accountIds: [SECOND] })
  })

  test("a home whose credential was rejected is a re-test, not a preference: demoted", () => {
    const candidates = pool().map((entry) =>
      entry.account.id === HOME ? credentialRejected(HOME) : entry,
    )
    const result = runPolicy("sticky", input(SESSION, candidates))
    expect(result.ordered.at(-1)?.account.id).toBe(HOME)
  })
})

describe("sticky: the recovery permit goes to a session already homed there", () => {
  test("a permit on another session's home does not pull this session onto it", () => {
    const permit = { halfOpen: true, recoveryPermit: true }
    const result = runPolicy("sticky", input(SESSION, pool({ [SECOND]: permit })))
    expect(result.ordered[0]?.account.id).toBe(HOME)
    expect(result.ordered.at(-1)?.account.id).toBe(SECOND)
    expect(result.notes.some((note) => note.kind === "recovery-promoted")).toBe(false)
  })

  test("a permit on this session's home is spent by it, first in line", () => {
    const permit = { halfOpen: true, recoveryPermit: true }
    const result = runPolicy("sticky", input(SESSION, pool({ [HOME]: permit })))
    expect(result.ordered[0]?.account.id).toBe(HOME)
  })

  test("every permit is still reachable: some session is homed on each account", () => {
    // The exit for the permit gate: across ordinary traffic, each account is somebody's home, so a
    // permit is never stranded by this rule (CLAUDE.md "Every gate needs an exit").
    const homes = new Set<string>()
    for (let index = 0; index < 200; index += 1) {
      const permit = { halfOpen: true, recoveryPermit: true }
      const result = runPolicy("sticky", input(`s-${index}`, pool({ a: permit })))
      if (result.ordered[0]?.account.id === "a") homes.add(`s-${index}`)
    }
    expect(homes.size).toBeGreaterThan(0)
  })
})

describe("other policies keep the old ordering — they carry no affinity to protect", () => {
  test("round-robin still promotes a permit and demotes a probe", () => {
    const result = runPolicy(
      "round-robin",
      input(SESSION, pool({ b: { halfOpen: true, recoveryPermit: true }, c: { halfOpen: true } })),
    )
    expect(result.ordered[0]?.account.id).toBe("b")
    expect(result.ordered.at(-1)?.account.id).toBe("c")
  })
})
