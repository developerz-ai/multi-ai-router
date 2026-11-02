import { expect, test } from "bun:test"
import { Hono } from "hono"
import { requestId } from "../../../src/middleware/requestId"
import type { AppEnv } from "../../../src/types"

/** The identity the middleware puts on the context, as the route hands it back. */
interface Identity {
  readonly requestId: string
  readonly correlationId: string
  readonly clientRequestId: string | null
}

function fixture() {
  const app = new Hono<AppEnv>()
  app.use("*", requestId())
  app.get("/", (c) =>
    c.json({
      requestId: c.get("requestId"),
      correlationId: c.get("correlationId"),
      clientRequestId: c.get("clientRequestId"),
    }),
  )
  return app
}

test("repeated caller UUID labels never share the ingress attempt join key", async () => {
  const app = fixture()
  const label = crypto.randomUUID()
  const first = await app.request("/", { headers: { "x-request-id": label } })
  const second = await app.request("/", { headers: { "x-request-id": label } })
  const a = (await first.json()) as Identity
  const b = (await second.json()) as Identity
  expect(first.headers.get("x-request-id")).toBe(label)
  expect(second.headers.get("x-request-id")).toBe(label)
  expect(a.clientRequestId).toBe(label)
  expect(b.clientRequestId).toBe(label)
  expect(a.correlationId).not.toBe(label)
  expect(a.correlationId).not.toBe(b.correlationId)
})

test("a router-minted trace label carries explicit absent-caller provenance", async () => {
  const response = await fixture().request("/")
  const identity = (await response.json()) as Identity
  expect(identity.clientRequestId).toBeNull()
  expect(identity.requestId).toBe(identity.correlationId)
  expect(response.headers.get("x-request-id")).toBe(identity.requestId)
})

test("an unsafe caller label is replaced without entering client metadata", async () => {
  const response = await fixture().request("/", { headers: { "x-request-id": "unsafe label" } })
  const identity = (await response.json()) as Identity
  expect(identity.clientRequestId).toBeNull()
  expect(identity.requestId).not.toBe("unsafe label")
  expect(response.headers.get("x-request-id")).toBe(identity.correlationId)
})
