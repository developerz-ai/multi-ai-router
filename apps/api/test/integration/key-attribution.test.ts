import { describe, expect, test } from "bun:test"
import { jsonResponse } from "../unit/dataplane/fixtures"
import { bearer, harness, KEY, MESSAGE, post } from "./harness"

/**
 * Attribution columns (`owner`, `owner_kind`, `tool`, `purpose`) are admin-plane
 * labels only. Migration 0033 adds them nullable with no default, so every key
 * minted before it crosses the migration as a row whose four new columns are
 * NULL — the fixture row this harness verifies with is exactly that image. The
 * data plane must keep serving such a key unchanged: authentication reads
 * prefix, value, scope, expiry and the revoked flag, never a label.
 */
describe("key attribution is inert on the data plane", () => {
  test("a pre-migration key — attribution columns all NULL — still authenticates and serves", async () => {
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
