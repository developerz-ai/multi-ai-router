import { expect, test } from "bun:test"
import { QuotaExhaustedError } from "@multi-ai-router/core"
import { Hono } from "hono"
import { createLogger } from "../../../src/logging/logger"
import { errorHandler } from "../../../src/middleware/errorHandler"
import type { AppEnv } from "../../../src/types"

for (const [seconds, expected] of [
  [0.01, "1"],
  [1.01, "2"],
  [2, "2"],
  [undefined, "30"],
] as const) {
  test(`temporary quota refusal renders positive integer Retry-After (${seconds})`, async () => {
    const app = new Hono<AppEnv>()
    app.onError(errorHandler(createLogger({ level: "error", write: () => {} })))
    app.get("/v1/messages", () => {
      throw new QuotaExhaustedError(
        "limited",
        seconds === undefined ? {} : { retryAfterSeconds: seconds },
      )
    })
    const response = await app.request("/v1/messages")
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe(expected)
  })
}
