import { describe, expect, test } from "bun:test"
import { NoHealthyAccountError } from "@multi-ai-router/core"
import { routerErrorObject } from "../../../src/errors/router-object"

/**
 * `error.router` leaves through the same scrub as the sentence beside it: a classifier signal or a
 * pool name is router-held text, but an operator or an upstream can put a credential in either.
 */
describe("routerErrorObject — what leaves is scrubbed", () => {
  const KEY = `sk-${"a".repeat(32)}`

  test("a credential in a signal or a pool name never reaches the body", () => {
    const error = new NoHealthyAccountError("x", {
      detail: { signal: `vendor:${KEY}`, pools: [`pool ${KEY}`] },
    })

    const rendered = JSON.stringify(routerErrorObject(error, null, null))

    expect(rendered).not.toContain(KEY)
    expect(rendered).toContain("[REDACTED]")
  })
})
