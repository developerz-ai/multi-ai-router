import { expect, test } from "bun:test"
import { account, jsonResponse } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

// Plan 101, 13.8: a chain whose every attempt failed on capacity answers `503` with a number to
// wait, instead of leaving each client to invent a ladder. A chain that failed for any other
// reason names none.
const accounts = [
  account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR }),
  account("acct-2", { apiKey: "sk-two", cipher: CRYPTOR }),
]

test("every attempt lost its connection: 503, capacity, Retry-After", async () => {
  const refused = () => {
    throw new TypeError("connection refused")
  }
  const { app } = harness({ accounts, responses: [refused, refused] })

  const res = await app.request("/v1/messages", post(undefined, bearer()))
  const body = (await res.json()) as {
    readonly error: { readonly router: { readonly wall: string; readonly retryable: boolean } }
  }
  await settle()

  expect(res.status).toBe(503)
  expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0)
  expect(body.error.router).toMatchObject({ wall: "capacity", retryable: true })
})

test("a chain that ended on a request-shaped failure names no wait", async () => {
  const { app } = harness({
    accounts: [account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR })],
    responses: [
      () => jsonResponse(400, { type: "error", error: { type: "invalid_request_error" } }),
    ],
  })
  const res = await app.request("/v1/messages", post(undefined, bearer()))
  await res.text()
  expect(res.headers.get("retry-after")).toBeNull()
})
