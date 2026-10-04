import { expect, test } from "bun:test"
import {
  createSdkConcurrency,
  createSdkInvoker,
  createSdkTestProbe,
  type SdkUsageGaugeObservation,
} from "../../../src/providers"
import { sdkQueryStream, sdkTurn } from "./fixtures"

for (const mode of ["invoker", "probe", "supplied"] as const) {
  test(`${mode} gauge captures original observation before the subprocess queue`, async () => {
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const signal = new AbortController().signal
    const occupied = await concurrency.acquire("sub", signal)
    const captured = Promise.withResolvers<void>()
    const observed = Promise.withResolvers<void>()
    const origin: SdkUsageGaugeObservation = { accepts: () => false, onReading: () => {} }
    const newer: SdkUsageGaugeObservation = { accepts: () => true, onReading: () => {} }
    let current = origin,
      captures = 0
    const gauge = {
      capture: () => {
        captures++
        captured.resolve()
        return current
      },
      observe: async (_id: string, _source: unknown, observation?: SdkUsageGaugeObservation) => {
        expect(observation).toBe(origin)
        expect(observation?.accepts()).toBe(false)
        observed.resolve()
      },
    }
    const runQuery = () => ({
      async *[Symbol.asyncIterator]() {
        if (mode === "probe") yield { type: "assistant", message: { content: [] } }
        yield* sdkQueryStream({
          turns: [
            sdkTurn({
              blocks: [
                [
                  { type: "text", text: "" },
                  { type: "text_delta", text: "pong" },
                ],
              ],
            }),
          ],
        })
      },
    })
    const resolveCli = () => ({
      ok: true as const,
      source: "env_override" as const,
      path: "/offline/claude",
      bytes: 1000,
    })
    let pending: Promise<unknown>
    if (mode === "probe") {
      const probe = createSdkTestProbe({ concurrency, runQuery, resolveCli, usageGauge: gauge })
      pending = probe.run({ accountId: "sub", configDir: "/offline/sub", model: "model", signal })
    } else {
      const invoke = createSdkInvoker({ concurrency, runQuery, resolveCli, usageGauge: gauge })
      pending = invoke({
        accountId: "sub",
        configDir: "/offline/sub",
        model: "model",
        signal,
        session: { kind: "fresh", reason: "no-session" },
        usageGaugeObservation: mode === "supplied" ? origin : undefined,
        body: new TextEncoder().encode(
          JSON.stringify({
            model: "model",
            stream: true,
            max_tokens: 1,
            messages: [{ role: "user", content: "offline" }],
          }),
        ),
      }).then((response) => response.text())
    }
    if (mode !== "supplied") await captured.promise
    expect(captures).toBe(mode === "supplied" ? 0 : 1)
    current = newer
    occupied.release()
    await pending
    await observed.promise
    expect(captures).toBe(mode === "supplied" ? 0 : 1)
    expect(concurrency.inFlight).toBe(0)
  })
}
