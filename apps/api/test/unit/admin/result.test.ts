import { describe, expect, test } from "bun:test"
import { failureBody, invalid, unavailable } from "../../../src/services/admin"
import { auditQuery } from "../../../src/services/settings/schema"

/** An agent reads `error.router.retryable`; a dependency that did not answer must not say never. */
describe("an admin failure tells its caller whether resending can work", () => {
  test("a wrong request does not", () => {
    const result = invalid("no", "invalid_request")
    if (result.ok) throw new Error("unreachable")
    expect(failureBody(result.failure, "r")).toMatchObject({
      error: { router: { wall: "request", retryable: false } },
    })
  })

  test("an unavailable dependency does, and says when", () => {
    const result = unavailable("down", "webshare_unavailable", 7)
    if (result.ok) throw new Error("unreachable")
    expect(result.failure.status).toBe(503)
    expect(failureBody(result.failure, "r")).toMatchObject({
      error: {
        code: "webshare_unavailable",
        router: { wall: "clock", retryable: true, retry_after_s: 7 },
      },
    })
  })
})

test("a NUL in an audit filter is refused at the edge", () => {
  for (const filter of [{ kind: "\0" }, { actor: "a\0" }])
    expect(auditQuery.safeParse(filter).success).toBe(false)
})
