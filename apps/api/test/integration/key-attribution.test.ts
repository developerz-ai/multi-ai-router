import { describe, expect, test } from "bun:test"
import { jsonResponse } from "../unit/dataplane/fixtures"
import { bearer, harness, KEY, MESSAGE, post } from "./harness"

/**
 * Attribution columns (`owner`, `owner_kind`, `tool`, `purpose`) are admin-plane
 * labels only. The fixture row this harness verifies with simply omits the four
 * attribution keys, so authentication is exercised on a row that carries no
 * labels. That proves the data plane never reads a label; it does NOT prove the
 * NULL-column path — that is covered against a real Postgres by
 * `packages/db/test/integration/api-key-attribution.test.ts`.
 */
describe("key attribution is inert on the data plane", () => {
  test("a key row carrying no attribution labels still authenticates and serves", async () => {
    const { app, upstream } = harness({ responses: [() => jsonResponse(200, { ok: true })] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    expect(res.status).toBe(200)
    expect(upstream.calls).toHaveLength(1)
  })

  test("the same key works in the Anthropic header form — labels do not gate the wire", async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, { ok: true })] })

    const res = await app.request("/v1/messages", post(MESSAGE, { "x-api-key": KEY }))
    expect(res.status).toBe(200)
  })
})
