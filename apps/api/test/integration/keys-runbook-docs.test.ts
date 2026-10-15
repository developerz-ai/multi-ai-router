import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  CreditsExhaustedError,
  KeyRateLimitedError,
  KeyRevokedError,
  KeyVerificationUnavailableError,
  NoHealthyAccountError,
  QuotaExhaustedError,
  type RouterError,
  ScopeViolationError,
} from "@multi-ai-router/core"

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
    expect(read("docs/idea/04-api-keys-and-access.md")).toContain("](../KEYS.md)")
  })

  // The error table is the part most likely to drift: a renamed code or a moved status must fail
  // here, not reach a key holder as advice.
  test("every error row's status matches its class", () => {
    const declared = new Map<string, number>(
      [
        new KeyRevokedError("x"),
        new CreditsExhaustedError("x"),
        new ScopeViolationError("x"),
        new KeyRateLimitedError("x"),
        new QuotaExhaustedError("x"),
        new KeyVerificationUnavailableError("x"),
        new NoHealthyAccountError("x"),
      ].map((e: RouterError) => [e.code, e.status]),
    )
    const rows = read("docs/KEYS.md")
      .split("\n")
      .filter((line) => /^\| \d{3} `/.test(line))
    const pairs = rows.flatMap((line) => {
      const status = Number(line.slice(2, 5))
      const cell = line.split("|")[1] ?? ""
      return [...cell.matchAll(/`([a-z_]+)`/g)].map((m) => ({ code: m[1], status }))
    })
    expect(pairs.length).toBe(declared.size)
    for (const { code, status } of pairs) {
      expect({ code, status }).toEqual({ code, status: declared.get(code ?? "") ?? -1 })
    }
  })
})
