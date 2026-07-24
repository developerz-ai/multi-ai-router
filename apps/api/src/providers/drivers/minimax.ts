import { z } from "zod"
import { createHttpDriver } from "../driver"
import { codeRule } from "../failure/classify"
import { readErrorFacts } from "../failure/error-body"
import type { UpstreamErrorFacts } from "../types"

/**
 * `minimax` — Anthropic-compatible surface, prepaid balance, own model ids.
 *
 * Like the other compatible vendors it takes its key as `Authorization: Bearer` alongside
 * `anthropic-version` — no `x-api-key`, and no Anthropic OAuth beta.
 *
 * The reason this is not a one-line config: **MiniMax reports failures in a `base_resp` envelope
 * that can arrive with HTTP 200.** A driver that reads only the status sees a success and hands
 * an error body to the client as if it were a completion, while a drained balance never marks the
 * account `exhausted`.
 */

/** Provenance: docs/idea/03-providers.md registry table. Blast radius: every `minimax` request. */
const BASE_URL = "https://api.minimax.io/anthropic"

/**
 * Provenance: MiniMax's `base_resp.status_code` vocabulary — `0` is success, `1008` is an
 * insufficient balance, `1002` is throttling, `1004` is a rejected key. Blast radius: these codes
 * are the only failure signal on the responses that carry a `200`.
 */
const BALANCE_CODES = ["1008"]
const THROTTLE_CODES = ["1002"]
const AUTH_CODES = ["1004"]
const SERVER_CODES = ["1000", "1013", "1039"]
const INVALID_REQUEST_CODES = ["1027", "2013"]

const MiniMaxEnvelope = z.object({
  base_resp: z.object({
    status_code: z.number(),
    status_msg: z.string().optional(),
  }),
})

/** `base_resp` first, then the ordinary dialect shapes — a MiniMax error may take either form. */
export function readMiniMaxFacts(body: unknown): UpstreamErrorFacts {
  const parsed = MiniMaxEnvelope.safeParse(body)
  if (parsed.success && parsed.data.base_resp.status_code !== 0) {
    return {
      code: String(parsed.data.base_resp.status_code),
      message: parsed.data.base_resp.status_msg,
    }
  }
  return readErrorFacts(body)
}

export const miniMaxDriver = createHttpDriver({
  id: "minimax",
  surfaces: [{ dialect: "anthropic", baseUrl: BASE_URL, anthropicAuth: "vendor-bearer" }],
  readFacts: readMiniMaxFacts,
  rules: [
    codeRule("credits-exhausted", "minimax:base_resp-1008", BALANCE_CODES),
    codeRule("rate-limited", "minimax:base_resp-1002", THROTTLE_CODES),
    codeRule("auth", "minimax:base_resp-1004", AUTH_CODES),
    codeRule("server-error", "minimax:base_resp-server", SERVER_CODES),
    codeRule("invalid-request", "minimax:base_resp-invalid", INVALID_REQUEST_CODES),
  ],
})
