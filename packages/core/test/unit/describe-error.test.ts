import { describe, expect, test } from "bun:test"
import { describeError } from "../../src"

/**
 * The one description used everywhere an error is persisted or logged. Two properties are
 * load-bearing: the innermost message — the actual complaint — comes first and survives every
 * cap, and an `AggregateError` (whose `message` defaults to `""`) reads as its sub-errors, not
 * as an empty string. Both were audited failures before this helper existed.
 */

describe("describeError — the cause chain", () => {
  test("joins innermost first, so the root complaint leads the line", () => {
    const error = new Error('Failed query: update "accounts" set "last_used_at" = $1', {
      cause: new Error("Received an instance of Date"),
    })

    expect(describeError(error, Number.POSITIVE_INFINITY)).toBe(
      'Received an instance of Date ← Failed query: update "accounts" set "last_used_at" = $1',
    )
  })

  test("truncation eats the wrapper's statement text, never the root complaint", () => {
    // The audited failure mode: a wrapper whose message is 500 chars of statement text would
    // fill a front-anchored budget on its own and discard the driver's complaint entirely.
    const error = new Error(`Failed query: insert ${"$1, ".repeat(500)}`, {
      cause: new Error("connection refused"),
    })

    const described = describeError(error, 80)

    expect(described).toHaveLength(80)
    expect(described).toStartWith("connection refused ← Failed query:")
    expect(described).toEndWith("…")
  })

  test("a message under the cap is returned whole, no ellipsis", () => {
    expect(describeError(new Error("boom"), 500)).toBe("boom")
  })

  test("a deep chain keeps the innermost messages and drops outer wrappers", () => {
    let error = new Error("root complaint")
    for (let layer = 1; layer <= 9; layer += 1) {
      error = new Error(`wrapper ${layer}`, { cause: error })
    }

    const described = describeError(error, Number.POSITIVE_INFINITY)

    expect(described).toStartWith("root complaint ← wrapper 1")
    // The cap trims from the outside in: the newest wrappers are the reconstructible ones.
    expect(described).not.toContain("wrapper 9")
  })

  test("a cyclic cause chain terminates", () => {
    const a = new Error("a")
    const b = new Error("b", { cause: a })
    a.cause = b

    expect(describeError(b, Number.POSITIVE_INFINITY)).toBe("a ← b")
  })

  test("a wrapper restating its cause verbatim is not repeated", () => {
    const error = new Error("same words", { cause: new Error("same words") })

    expect(describeError(error, Number.POSITIVE_INFINITY)).toBe("same words")
  })

  test("a subclass's name survives; the bare 'Error' name says nothing and is dropped", () => {
    const error = new Error("wrapper", { cause: new TypeError("bad bind") })

    expect(describeError(error, Number.POSITIVE_INFINITY)).toBe("TypeError: bad bind ← wrapper")
  })

  test("a non-Error throwable is stringified", () => {
    expect(describeError("just a string", 100)).toBe("just a string")
    expect(describeError(42, 100)).toBe("42")
  })

  test("a non-Error cause ends the chain but is quoted", () => {
    const error = new Error("wrapper", { cause: "ECONNRESET" })

    expect(describeError(error, Number.POSITIVE_INFINITY)).toBe("ECONNRESET ← wrapper")
  })
})

describe("describeError — AggregateError", () => {
  test("an empty-message aggregate reads as its sub-errors — the Postgres-outage shape", () => {
    // Bun's multi-address connect refusal: AggregateError, message "", payload in .errors.
    const error = new AggregateError([
      new Error("connect ECONNREFUSED ::1:5432"),
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
    ])

    expect(describeError(error, Number.POSITIVE_INFINITY)).toBe(
      "connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432",
    )
  })

  test("an aggregate with its own message keeps it ahead of the sub-errors", () => {
    const error = new AggregateError([new Error("first"), new Error("second")], "all fell over")

    expect(describeError(error, Number.POSITIVE_INFINITY)).toBe("all fell over: first; second")
  })

  test("an aggregate mid-chain still contributes its sub-errors", () => {
    const error = new Error("failed to connect", {
      cause: new AggregateError([new Error("connect ECONNREFUSED 127.0.0.1:5432")]),
    })

    expect(describeError(error, Number.POSITIVE_INFINITY)).toBe(
      "connect ECONNREFUSED 127.0.0.1:5432 ← failed to connect",
    )
  })

  test("a pathological aggregate is capped with a count, not quoted whole", () => {
    const error = new AggregateError(
      Array.from({ length: 12 }, (_, index) => new Error(`sub ${index}`)),
    )

    const described = describeError(error, Number.POSITIVE_INFINITY)

    expect(described).toContain("sub 4")
    expect(described).not.toContain("sub 5")
    expect(described).toEndWith("+7 more")
  })

  test("an aggregate with no errors and no message still says its name", () => {
    expect(describeError(new AggregateError([]), 100)).toBe("AggregateError")
  })
})
