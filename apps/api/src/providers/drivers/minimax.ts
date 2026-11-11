import { z } from "zod"
import { createHttpDriver } from "../driver"
import { codeRule, messageRule } from "../failure/classify"
import { readErrorFacts } from "../failure/error-body"
import type { FailureClassification, ProviderDriver, UpstreamErrorFacts } from "../types"
import { miniMaxQuotaRead } from "./minimax-quota"

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

/**
 * Provenance: prod, 2026-11-06 (every recheck of the `minimax` account): `429 Token Plan usage limit
 * reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)`, in the message, no
 * `base_resp`, no reset header. A spent plan window: `rate-limited`, which the `429` already said —
 * the rule names the signal, and keeps the word "Credits" from ever reading as a dead balance. The
 * reset lives on the plan's own usage endpoint (`minimax-quota.ts`). Blast radius: the signal name.
 */
const TOKEN_PLAN_LIMIT = /token plan usage limit|\(2056\)\s*$/i

/**
 * Provenance: MiniMax's own refusal, prod 2026-11-05 22:41Z onward (61 `400`s): `model
 * "MiniMax-M3.1-Flash" requires adaptive thinking; thinking.type="disabled" (including
 * reasoning.effort=none) is not allowed (2013)`. The client named it `MiniMax-M3.1-Flash-Preview`,
 * so the pattern covers the family and its suffixed ids, in any case: with no alias the client's
 * spelling is what goes upstream (`routing/model.ts`). MiniMax-M3 itself accepts `disabled`
 * (measured 2026-10-15). Blast radius: a model matched here keeps thinking on beside a forced tool;
 * a model missed here is refused `400` (2013) on every forced-tool request.
 */
const THINKING_REQUIRED_MODELS = /^MiniMax-M3\.1-Flash(?:-|$)/i

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

/** Only this provider's declared envelope is inspected on a successful response. */
export function inspectMiniMaxSuccess(body: unknown) {
  const parsed = MiniMaxEnvelope.safeParse(body)
  const code = parsed.success ? parsed.data.base_resp.status_code : 0
  if (code === 0) return null
  const value = String(code)
  const kind = BALANCE_CODES.includes(value)
    ? "credits-exhausted"
    : THROTTLE_CODES.includes(value)
      ? "rate-limited"
      : AUTH_CODES.includes(value)
        ? "auth"
        : INVALID_REQUEST_CODES.includes(value)
          ? "invalid-request"
          : "server-error"
  return {
    kind,
    status: 200,
    retryable: kind !== "invalid-request",
    signal: `minimax:base_resp-${BALANCE_CODES.includes(value) || THROTTLE_CODES.includes(value) || AUTH_CODES.includes(value) || SERVER_CODES.includes(value) || INVALID_REQUEST_CODES.includes(value) ? value : "unknown"}`,
    rateLimit: null,
  } satisfies FailureClassification
}

export const miniMaxDriver: ProviderDriver = {
  ...createHttpDriver({
    responseObservation: { terminalPolicy: "evidence-only", inspectPayload: inspectMiniMaxSuccess },
    id: "minimax",
    surfaces: [
      {
        dialect: "anthropic",
        baseUrl: BASE_URL,
        anthropicAuth: "vendor-bearer",
        thinkingOnByDefault: true,
        thinkingRequiredModels: THINKING_REQUIRED_MODELS,
      },
    ],
    readFacts: readMiniMaxFacts,
    rules: [
      codeRule("credits-exhausted", "minimax:base_resp-1008", BALANCE_CODES),
      codeRule("rate-limited", "minimax:base_resp-1002", THROTTLE_CODES),
      messageRule("rate-limited", "minimax:token-plan-limit", TOKEN_PLAN_LIMIT, {
        statuses: [429],
      }),
      codeRule("auth", "minimax:base_resp-1004", AUTH_CODES),
      codeRule("server-error", "minimax:base_resp-server", SERVER_CODES),
      codeRule("invalid-request", "minimax:base_resp-invalid", INVALID_REQUEST_CODES),
    ],
  }),
  quotaRead: miniMaxQuotaRead,
  // The idle keepalive/probe's one minimal turn: the cheapest current model this provider serves.
  // Provenance: carried from `scheduler/tasks/idle-account-probe.ts` IDLE_PROBE_MODELS (sweep 101).
  idleProbeModel: "MiniMax-M2",
}
