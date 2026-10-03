import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"
import { runAttempt } from "../../../src/services/dataplane/attempt"
import { account, cipher } from "./fixtures"

describe("HTTP final upstream admission", () => {
  test("refusal after credential preparation prevents fetch without an account failure", async () => {
    const cryptor = cipher()
    let decrypted = false
    let calls = 0
    const driver = httpDriver("anthropic-api")
    if (driver === undefined) throw new Error("missing HTTP fixture driver")
    const result = await runAttempt({
      plan: {
        account: account("a", { cipher: cryptor }),
        driver,
        dialect: "anthropic",
        url: new URL("https://upstream.test/v1/messages"),
        upstreamModel: "claude",
      },
      method: "POST",
      clientHeaders: new Headers(),
      body: null,
      timeoutMs: 1000,
      cipher: {
        decrypt: (value) => {
          decrypted = true
          return cryptor.decrypt(value)
        },
      },
      fetch: async () => {
        calls += 1
        return new Response("ok")
      },
      beforeUpstreamStart: () => {
        expect(decrypted).toBe(true)
        throw new UpstreamAdmissionRefused()
      },
    })
    expect(result).toEqual({ kind: "admission-refused" })
    expect(calls).toBe(0)
  })
  test("already cancelled request does not consume admission", async () => {
    const driver = httpDriver("anthropic-api")
    if (driver === undefined) throw new Error("missing HTTP fixture driver")
    const controller = new AbortController()
    controller.abort()
    let admitted = false
    let fetched = false
    const result = await runAttempt({
      plan: {
        account: account("a"),
        driver,
        dialect: "anthropic",
        url: new URL("https://upstream.test"),
        upstreamModel: "claude",
      },
      method: "POST",
      clientHeaders: new Headers(),
      body: null,
      timeoutMs: 1000,
      cipher: cipher(),
      signal: controller.signal,
      fetch: async () => {
        fetched = true
        return new Response()
      },
      beforeUpstreamStart: () => {
        admitted = true
      },
    })
    expect(result.kind).toBe("failure")
    expect(admitted).toBe(false)
    expect(fetched).toBe(false)
  })
})
