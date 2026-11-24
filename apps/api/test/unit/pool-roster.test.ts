import { expect, test } from "bun:test"
import { EnvValidationError, parseEnv } from "../../src/config/env"
import { type PoolRoster, poolRosterSchema } from "../../src/config/pool-roster"

const base = {
  DATABASE_URL: "postgres://router:router@localhost/router",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
}
const pool = {
  name: "demo",
  members: ["primary", "overflow"],
  overflow: "overflow",
  quotaSoftLimit: 0.8,
}

test("v1 preserves exact identities and allows shared labels across pools", () => {
  const roster = { version: 1, pools: [pool, { ...pool, name: "Demo" }] } satisfies PoolRoster
  expect(poolRosterSchema.parse(roster)).toEqual(roster)
  expect(poolRosterSchema.parse({ version: 1, pools: [] }).pools).toEqual([])
})

for (const [name, value] of Object.entries({
  version: { version: 2, pools: [] },
  stringVersion: { version: "1", pools: [] },
  missing: {},
  nullRoot: null,
  wrongPools: { version: 1, pools: {} },
  unknownRoot: { version: 1, pools: [], extra: "secret" },
  unknownPool: { version: 1, pools: [{ ...pool, extra: "secret" }] },
  blankName: { version: 1, pools: [{ ...pool, name: " \t" }] },
  blankMember: { version: 1, pools: [{ ...pool, members: ["", "overflow"] }] },
  blankOverflow: { version: 1, pools: [{ ...pool, overflow: " " }] },
  wrongMember: { version: 1, pools: [{ ...pool, members: [1, "overflow"] }] },
  emptyMembers: { version: 1, pools: [{ ...pool, members: [] }] },
  duplicatePools: { version: 1, pools: [pool, pool] },
  duplicateMembers: { version: 1, pools: [{ ...pool, members: ["overflow", "overflow"] }] },
  outsider: { version: 1, pools: [{ ...pool, overflow: "Overflow" }] },
  soleOverflow: { version: 1, pools: [{ ...pool, members: ["overflow"] }] },
})) {
  test(`schema refuses ${name}`, () => {
    expect(poolRosterSchema.safeParse(value).success).toBe(false)
  })
}

test("parseEnv is pure, disabled by default, and accepts only absolute configured paths", () => {
  for (const path of [undefined, "", " \t"]) {
    const env = parseEnv({ ...base, POOL_ROSTER_PATH: path })
    expect(env.poolRosterPath).toBeNull()
    expect(env.poolRoster).toBeNull()
    expect(env.poolRosterCheckIntervalMinutes).toBe(15)
  }
  const env = parseEnv({ ...base, POOL_ROSTER_PATH: "/not-a-real-roster.json" })
  expect(env.poolRosterPath).toBe("/not-a-real-roster.json")
  expect(env.poolRoster).toBeNull()
  expect(() => parseEnv({ ...base, POOL_ROSTER_PATH: "relative.json" })).toThrow(/POOL_ROSTER_PATH/)
  expect(
    parseEnv({ ...base, POOL_ROSTER_CHECK_INTERVAL_MINUTES: "1" }).poolRosterCheckIntervalMinutes,
  ).toBe(1)
})

for (const value of ["0", "-1", "1.5", "Infinity", "NaN", "no", "1e100", "40000"]) {
  test(`interval refuses ${value}`, () => {
    expect(() => parseEnv({ ...base, POOL_ROSTER_CHECK_INTERVAL_MINUTES: value })).toThrow(
      EnvValidationError,
    )
  })
}

test("interval timer ceiling includes configured positive jitter", () => {
  const raw = { ...base, SCHEDULER_JITTER_FRACTION: "0.5" }
  const env = parseEnv({ ...raw, POOL_ROSTER_CHECK_INTERVAL_MINUTES: "23860" })
  expect(env.poolRosterCheckIntervalMinutes).toBe(23860)
  expect(() => parseEnv({ ...raw, POOL_ROSTER_CHECK_INTERVAL_MINUTES: "23861" })).toThrow(
    /POOL_ROSTER_CHECK_INTERVAL_MINUTES/,
  )
})
