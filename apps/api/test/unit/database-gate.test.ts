import { describe, expect, test } from "bun:test"
import { databaseGateRefusal, databaseRequired } from "../support/database-gate"

/**
 * The decision half of the gate that keeps `bin/check`'s promise honest: a run
 * that promised a database must not report a pass it did not earn. The exit
 * itself lives in `database-gate-preload.ts`; everything worth asserting is
 * here, where no process has to die to assert it.
 */

describe("databaseRequired", () => {
  test("a bare run promises nothing, so it is not required", () => {
    expect(databaseRequired({})).toBe(false)
  })

  test("CI requires one — a green run there is what a merge is decided on", () => {
    expect(databaseRequired({ CI: "true" })).toBe(true)
  })

  test("an empty CI is unset, matching every shell that spells it that way", () => {
    expect(databaseRequired({ CI: "" })).toBe(false)
  })

  test("bin/check's flag requires one", () => {
    expect(databaseRequired({ ROUTER_TEST_REQUIRE_DATABASE: "1" })).toBe(true)
  })

  test("only an explicit 1 counts, so an unexported leftover cannot arm the gate", () => {
    expect(databaseRequired({ ROUTER_TEST_REQUIRE_DATABASE: "0" })).toBe(false)
    expect(databaseRequired({ ROUTER_TEST_REQUIRE_DATABASE: "" })).toBe(false)
  })
})

describe("databaseGateRefusal", () => {
  test("lets a bare database-less run through — it is the no-Docker laptop loop", () => {
    expect(databaseGateRefusal({})).toBeNull()
  })

  test("lets a required run through once a database is there", () => {
    expect(
      databaseGateRefusal({ CI: "true", DATABASE_URL: "postgres://router@localhost:5432/router" }),
    ).toBeNull()
  })

  test("refuses a required run with no database at all", () => {
    expect(databaseGateRefusal({ CI: "true" })).not.toBeNull()
  })

  test("treats a blanked DATABASE_URL as missing — an empty string connects to nothing", () => {
    expect(databaseGateRefusal({ CI: "true", DATABASE_URL: "" })).not.toBeNull()
  })

  test("names which promise was broken, so CI and bin/check do not read alike", () => {
    expect(databaseGateRefusal({ CI: "true" })).toContain("CI is set")
    expect(databaseGateRefusal({ ROUTER_TEST_REQUIRE_DATABASE: "1" })).toContain("bin/check")
  })

  test("says what went unproven, not just that something did", () => {
    const refusal = databaseGateRefusal({ CI: "true" }) ?? ""

    expect(refusal).toContain("migrations")
    expect(refusal).toContain("advisory-lock")
    expect(refusal).toContain("retention")
    expect(refusal).toContain("readiness probe")
  })

  test("carries the remedy, so the reader never has to go looking for bin/setup", () => {
    expect(databaseGateRefusal({ CI: "true" })).toContain("bin/setup")
  })

  test("explains the dotenv rule that hides a DATABASE_URL that is plainly set", () => {
    const refusal = databaseGateRefusal({ ROUTER_TEST_REQUIRE_DATABASE: "1" }) ?? ""

    // Someone looking at a .env with a URL in it concludes the gate is broken and
    // reaches for a way around it, unless it tells them which file was read.
    expect(refusal).toContain(".env.test")
    expect(refusal).toContain(".env.local")
  })
})
