import { expect, test } from "bun:test"
import { jsonResponse } from "../unit/dataplane/fixtures"
import { bearer, harness, MESSAGE, post } from "./harness"

/**
 * Every request that reaches a data-plane route counts in `router_requests_total` exactly once
 * (tesote, 2.56.0): a request refused before dispatch — an unknown key, a key store that could not
 * answer — used to be invisible to every alert built on that counter.
 */
const ANSWER = { id: "msg_1", type: "message", content: [{ type: "text", text: "hi" }] }

function requestsTotal(body: string): Map<string, number> {
  const series = new Map<string, number>()
  for (const line of body.split("\n")) {
    if (!line.startsWith("router_requests_total{")) continue
    const at = line.lastIndexOf(" ")
    series.set(line.slice(0, at), Number(line.slice(at + 1)))
  }
  return series
}

test("a refused key counts with its outcome; a dispatched request counts once", async () => {
  const { app } = harness({ responses: [() => jsonResponse(200, ANSWER)] })

  const refused = await app.request(
    "/v1/messages",
    post(MESSAGE, { authorization: "Bearer mar_live_00000000000000000000000000000000" }),
  )
  expect(refused.status).toBe(401)
  await refused.text()
  const missing = await app.request("/v1/chat/completions", post(MESSAGE))
  expect(missing.status).toBe(401)
  await missing.text()
  const served = await app.request("/v1/messages", post(MESSAGE, bearer()))
  expect(served.status).toBe(200)
  await served.text()

  const series = requestsTotal(await (await app.request("/metrics")).text())
  const refusedSeries = [...series].filter(([labels]) => labels.includes('outcome="key_revoked"'))
  expect(refusedSeries.map(([labels]) => labels.includes('key_id="none"'))).toEqual([true, true])
  expect(refusedSeries.reduce((sum, [, count]) => sum + count, 0)).toBe(2)
  const successes = [...series].filter(([labels]) => labels.includes('outcome="success"'))
  expect(successes.reduce((sum, [, count]) => sum + count, 0)).toBe(1)
})
