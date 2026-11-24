import { describe, expect, test } from "bun:test"
import { type PoolRoster, poolRosterSchema } from "../../../src/config/pool-roster"
import {
  diffRoster,
  type LiveRoster,
  type LiveRosterPool,
  type RosterDriftItem,
} from "../../../src/scheduler/tasks/pool-roster-diff"

/**
 * Pure: a roster in, a live snapshot in, the drift out. No store, no clock, no I/O — which is why
 * every kind can be pinned here without a fixture that has to be true of a database.
 *
 * The live side is spelled as a database would hold it: accounts by id with their label, pools by
 * id with their name, their `pool_members` ids, and the pool's own `overflow_account_id`.
 */

const ROSTER: PoolRoster = {
  version: 1,
  pools: [
    { name: "claude-team", members: ["alice", "bob"], overflow: "alice", quotaSoftLimit: 0.8 },
    { name: "gpt-team", members: ["carol", "dave"], overflow: "carol", quotaSoftLimit: 0.8 },
  ],
}

function livePool(
  name: string,
  memberIds: readonly string[],
  overflowAccountId: string | null = null,
  id = `pool-${name}`,
): LiveRosterPool {
  return { id, name, memberIds, overflowAccountId }
}

const ACCOUNTS = [
  { id: "acc-alice", label: "alice" },
  { id: "acc-bob", label: "bob" },
  { id: "acc-carol", label: "carol" },
  { id: "acc-dave", label: "dave" },
  { id: "acc-mallory", label: "mallory" },
] as const

/** Both pools exactly as the roster names them: members present, overflow configured. */
function cleanLive(): LiveRoster {
  return {
    pools: [
      livePool("claude-team", ["acc-alice", "acc-bob"], "acc-alice"),
      livePool("gpt-team", ["acc-carol", "acc-dave"], "acc-carol"),
    ],
    accounts: ACCOUNTS,
  }
}

function kinds(items: readonly RosterDriftItem[]): readonly string[] {
  return items.map((item) => item.kind).sort()
}

/**
 * A live side that is wrong in every way the check can name, against a roster that adds a pool the
 * live side has never heard of.
 */
const DRIFTED: LiveRoster = {
  pools: [
    // alice kept, bob missing, mallory added, and the pool engages no overflow at all.
    livePool("claude-team", ["acc-alice", "acc-mallory"], null),
    // carol gone (the live row holds an unknown account), overflow points at an ex-member.
    livePool("gpt-team", ["acc-ghost"], "acc-mallory"),
  ],
  accounts: ACCOUNTS,
}

const WITH_GONE: PoolRoster = {
  version: 1,
  pools: [
    ...ROSTER.pools,
    { name: "gone-team", members: ["alice", "bob"], overflow: "alice", quotaSoftLimit: 0.8 },
  ],
}

describe("diffRoster", () => {
  test("the roster fixtures are rosters the loader would accept", () => {
    // The loader refuses an overflow that is its pool's sole member, a duplicate member and a
    // duplicate pool name — so a fixture that broke those rules would pin behaviour no real
    // `POOL_ROSTER_PATH` can express.
    expect(poolRosterSchema.safeParse(ROSTER).success).toBe(true)
    expect(poolRosterSchema.safeParse(WITH_GONE).success).toBe(true)
  })
  test("a clean roster yields no items", () => {
    expect(diffRoster(ROSTER, cleanLive())).toEqual([])
  })

  test("a roster pool with no live pool reports pool_missing, carrying the roster name", () => {
    const live = cleanLive()
    const items = diffRoster(ROSTER, { ...live, pools: live.pools.slice(1) })
    expect(items).toEqual([
      {
        kind: "pool_missing",
        poolName: "claude-team",
        poolId: null,
        accountLabel: null,
        accountId: null,
      },
    ])
  })

  test("a roster member the live pool does not hold reports missing_member", () => {
    const live = cleanLive()
    const items = diffRoster(ROSTER, {
      ...live,
      pools: [livePool("claude-team", ["acc-alice"], "acc-alice"), live.pools[1] as LiveRosterPool],
    })
    expect(items).toEqual([
      {
        kind: "missing_member",
        poolName: "claude-team",
        poolId: "pool-claude-team",
        accountLabel: "bob",
        accountId: "acc-bob",
      },
    ])
  })

  test("a live member the roster never names reports unexpected_member with the live label", () => {
    const live = cleanLive()
    const items = diffRoster(ROSTER, {
      ...live,
      pools: [
        livePool("claude-team", ["acc-alice", "acc-bob", "acc-mallory"], "acc-alice"),
        live.pools[1] as LiveRosterPool,
      ],
    })
    expect(items).toEqual([
      {
        kind: "unexpected_member",
        poolName: "claude-team",
        poolId: "pool-claude-team",
        accountLabel: "mallory",
        accountId: "acc-mallory",
      },
    ])
  })

  test("no overflow configured reports no_overflow naming the roster's pick", () => {
    const live = cleanLive()
    const items = diffRoster(ROSTER, {
      ...live,
      pools: [
        livePool("claude-team", ["acc-alice", "acc-bob"], null),
        live.pools[1] as LiveRosterPool,
      ],
    })
    expect(items).toEqual([
      {
        kind: "no_overflow",
        poolName: "claude-team",
        poolId: "pool-claude-team",
        accountLabel: "alice",
        accountId: null,
      },
    ])
  })

  test("an overflow that is not one of the live pool's members reports overflow_mismatch", () => {
    const live = cleanLive()
    const items = diffRoster(ROSTER, {
      ...live,
      pools: [
        livePool("claude-team", ["acc-alice", "acc-bob"], "acc-mallory"),
        live.pools[1] as LiveRosterPool,
      ],
    })
    expect(items).toEqual([
      {
        kind: "overflow_mismatch",
        poolName: "claude-team",
        poolId: "pool-claude-team",
        accountLabel: "mallory",
        accountId: "acc-mallory",
      },
    ])
  })

  test("an overflow that is a member but not the roster's pick reports overflow_mismatch", () => {
    const live = cleanLive()
    const items = diffRoster(ROSTER, {
      ...live,
      pools: [
        livePool("claude-team", ["acc-alice", "acc-bob"], "acc-bob"),
        live.pools[1] as LiveRosterPool,
      ],
    })
    expect(items).toEqual([
      {
        kind: "overflow_mismatch",
        poolName: "claude-team",
        poolId: "pool-claude-team",
        accountLabel: "bob",
        accountId: "acc-bob",
      },
    ])
  })

  test("a roster label no live account answers reports missing_member with no id", () => {
    const live = cleanLive()
    const items = diffRoster(
      {
        pools: [
          {
            name: "claude-team",
            members: ["alice", "ghost"],
            overflow: "alice",
            quotaSoftLimit: 0.8,
          },
        ],
      },
      {
        ...live,
        pools: [livePool("claude-team", ["acc-alice"], "acc-alice")],
      },
    )
    expect(items).toEqual([
      {
        kind: "missing_member",
        poolName: "claude-team",
        poolId: "pool-claude-team",
        accountLabel: "ghost",
        accountId: null,
      },
    ])
  })

  test("a live pool the roster does not name is not drift", () => {
    const live = cleanLive()
    const items = diffRoster(ROSTER, {
      ...live,
      pools: [...live.pools, livePool("operator-ad-hoc", ["acc-mallory"], "acc-mallory")],
    })
    expect(items).toEqual([])
  })

  test("every kind at once, in a stable order", () => {
    expect(
      diffRoster(WITH_GONE, DRIFTED).map(
        (item) => `${item.poolName}/${item.kind}/${item.accountLabel ?? "-"}`,
      ),
    ).toEqual([
      "claude-team/missing_member/bob",
      "claude-team/unexpected_member/mallory",
      "claude-team/no_overflow/alice",
      "gone-team/pool_missing/-",
      "gpt-team/missing_member/carol",
      "gpt-team/missing_member/dave",
      // No live account answers the label `ghost`, so the item names the id alone.
      "gpt-team/unexpected_member/-",
      "gpt-team/overflow_mismatch/mallory",
    ])
  })

  test("dropping a kind from the fold would change the output — each kind is load-bearing", () => {
    // One entry per kind, so a fold that stopped reporting any single one of them fails here rather
    // than passing on the six it still reports.
    expect(kinds(diffRoster(WITH_GONE, DRIFTED))).toEqual([
      "missing_member",
      "missing_member",
      "missing_member",
      "no_overflow",
      "overflow_mismatch",
      "pool_missing",
      "unexpected_member",
      "unexpected_member",
    ])
  })
})
