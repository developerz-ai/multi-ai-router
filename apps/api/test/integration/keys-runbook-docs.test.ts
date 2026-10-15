import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * The keys runbook is the one place an operator and a requester learn the key lifecycle, so it has
 * to exist and be reachable from the two documents people actually open. The files read are the
 * artifacts under test; there is nothing to inject in their place.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const read = (path: string): string => readFileSync(`${ROOT}${path}`, "utf8")

describe("docs/KEYS.md", () => {
  test("exists and stays under 300 lines", () => {
    expect(existsSync(`${ROOT}docs/KEYS.md`)).toBe(true)
    expect(read("docs/KEYS.md").split("\n").length).toBeLessThanOrEqual(300)
  })

  test("README.md links it", () => {
    expect(read("README.md")).toContain("docs/KEYS.md")
  })

  test("docs/idea/04-api-keys-and-access.md links it", () => {
    expect(read("docs/idea/04-api-keys-and-access.md")).toContain("KEYS.md")
  })
})
