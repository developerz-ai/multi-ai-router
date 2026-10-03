import { expect, test } from "bun:test"
import { claudeSdkDriver } from "../../../src/providers/claude-sdk/driver"
import { openAiCompatibleDriver } from "../../../src/providers/drivers/openai-compatible"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"
import { runAttempt } from "../../../src/services/dataplane/attempt"
import { runSdkAttempt } from "../../../src/services/dataplane/sdk-attempt"
import { account, cipher, subscriptionAccount } from "./fixtures"

for (const mode of ["decrypt", "headers", "guard", "fetch-error", "success"] as const) {
  test(`HTTP ${mode} reports local start only at actual fetch invocation`, async () => {
    const cryptor = cipher()
    const upstream = account("api", { provider: "openai-compatible", cipher: cryptor })
    const events: string[] = []
    const operation = runAttempt({
      plan: {
        account: upstream,
        driver: {
          ...openAiCompatibleDriver,
          buildHeaders: (...args) => {
            events.push("headers")
            if (mode === "headers") throw new Error("header preparation failed")
            return openAiCompatibleDriver.buildHeaders(...args)
          },
        },
        dialect: "openai-chat",
        url: new URL("http://offline.test/chat/completions"),
        upstreamModel: "model",
      },
      method: "POST",
      clientHeaders: new Headers(),
      body: new TextEncoder().encode("{}"),
      timeoutMs: 1000,
      cipher: {
        decrypt: (value) => {
          if (mode === "decrypt") throw new Error("credential preparation failed")
          return cryptor.decrypt(value)
        },
      },
      beforeUpstreamStart: () => {
        events.push("guard")
        if (mode === "guard") throw new UpstreamAdmissionRefused()
      },
      onUpstreamStarted: () => {
        events.push("started")
      },
      fetch: async () => {
        events.push("fetch")
        if (mode === "fetch-error") throw new Error("connect failed")
        return new Response("{}", { status: 200 })
      },
    })
    if (mode === "decrypt" || mode === "headers")
      await expect(operation).rejects.toThrow("preparation failed")
    else {
      const result = await operation
      expect(result.kind).toBe(
        mode === "guard" ? "admission-refused" : mode === "fetch-error" ? "failure" : "success",
      )
    }
    if (mode === "decrypt" || mode === "headers" || mode === "guard") {
      expect(events).not.toContain("started")
      expect(events).not.toContain("fetch")
    } else expect(events).toEqual(["headers", "guard", "started", "fetch"])
  })
}
test("SDK attempt forwards start evidence without treating invoker construction as a launch", async () => {
  const upstream = subscriptionAccount("sub")
  let callbacks = 0
  const held = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const pending = runSdkAttempt({
    plan: {
      kind: "sdk",
      candidate: {
        account: upstream.snapshot,
        poolId: null,
        weight: 100,
        priority: 0,
        order: 0,
        upstreamModel: "model",
        halfOpen: false,
      },
      account: upstream,
      driver: claudeSdkDriver,
      dialect: "anthropic",
      configDir: "/offline/sub",
      upstreamModel: "model",
      translation: null,
      egressMode: "agent-sdk",
    },
    body: null,
    session: undefined,
    timeoutMs: 1000,
    onUpstreamStarted: () => {
      callbacks++
    },
    invoke: async (input) => {
      entered.resolve()
      await held.promise
      expect(callbacks).toBe(0)
      input.onUpstreamStarted?.()
      return new Response("{}", { status: 200 })
    },
  })
  await entered.promise
  expect(callbacks).toBe(0)
  held.resolve()
  expect((await pending).kind).toBe("success")
  expect(callbacks).toBe(1)
})
