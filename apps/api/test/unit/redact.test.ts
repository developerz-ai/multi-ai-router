import { describe, expect, test } from "bun:test"
import { generateRouterKey } from "@multi-ai-router/core"
import { createLogger } from "../../src/logging/logger"
import { REDACTED, redact } from "../../src/logging/redact"

describe("redact", () => {
  test("scrubs credential-bearing field names whatever the value is", () => {
    const safe = redact({
      authorization: "Bearer sk-live-abcdef",
      "x-api-key": "mar_live_abc",
      cookie: "session=1",
      admin_password: "hunter2",
      refresh_token: "rt_123",
      code_verifier: "v_123",
      requestId: "req-1",
    })

    expect(safe).toEqual({
      authorization: REDACTED,
      "x-api-key": REDACTED,
      cookie: REDACTED,
      admin_password: REDACTED,
      refresh_token: REDACTED,
      code_verifier: REDACTED,
      requestId: "req-1",
    })
  })

  test("scrubs a router key that turns up under an innocent field name", () => {
    const key = generateRouterKey()
    const safe = redact({ note: `client sent ${key} twice` })

    expect(safe.note).toBe(`client sent ${REDACTED} twice`)
    expect(JSON.stringify(safe)).not.toContain(key)
  })

  test("scrubs nested objects and arrays", () => {
    const safe = redact({ upstream: { headers: { authorization: "Bearer abc" } }, tries: [1, 2] })

    expect(safe).toEqual({ upstream: { headers: { authorization: REDACTED } }, tries: [1, 2] })
  })
})

describe("createLogger", () => {
  test("emits one redacted JSON line per event, with the bound fields", () => {
    const lines: string[] = []
    const log = createLogger({ level: "info", write: (line) => lines.push(line) })

    log.child({ requestId: "req-1" }).warn("upstream failed", { authorization: "Bearer abc" })

    expect(lines).toHaveLength(1)
    const entry: unknown = JSON.parse(lines[0] ?? "{}")
    expect(entry).toMatchObject({
      level: "warn",
      msg: "upstream failed",
      requestId: "req-1",
      authorization: REDACTED,
    })
  })

  test("drops everything below the configured level", () => {
    const lines: string[] = []
    const log = createLogger({ level: "warn", write: (line) => lines.push(line) })

    log.debug("noisy")
    log.info("routine")
    log.error("real")

    expect(lines).toHaveLength(1)
  })
})
