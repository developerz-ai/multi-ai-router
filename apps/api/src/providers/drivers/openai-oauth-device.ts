import { z } from "zod"
import type { DevicePollResult, ProviderDeviceFlow } from "../device-flow"

/**
 * ChatGPT/Codex device-code sign-in — the half of `openai-oauth.ts` that `codex login
 * --device-auth` drives. Split out only to keep that file under the size limit; it belongs to the
 * same provider and changes with it.
 *
 * Provenance for every constant below: openai/codex `codex-rs/login/src/device_code_auth.rs` at
 * commit de3721a7be07054c8c2a41102b5a501f34155361, cross-checked against opencode's
 * `plugin/openai/codex.ts` "ChatGPT Pro/Plus (headless)" method. Blast radius: every device-code
 * connect of a ChatGPT account. A changed path or shape fails the connect with a status the console
 * shows; nothing already connected is touched — refresh is the ordinary refresh-token grant.
 */

/** `{issuer}/api/accounts` — `request_device_code` / `complete_device_code_login`. */
function accountsApi(issuer: string): string {
  return `${issuer}/api/accounts`
}

// `POST {issuer}/api/accounts/deviceauth/usercode`, JSON `{client_id}`. A 404 means device login
// is not enabled for this client (codex surfaces exactly that sentence).
export const OPENAI_DEVICE_USERCODE_PATH = "/deviceauth/usercode"
// `POST {issuer}/api/accounts/deviceauth/token`, JSON `{device_auth_id, user_code}`. 403 and 404
// both mean "not yet" (`poll_for_token`); 2xx carries the code; anything else is final.
export const OPENAI_DEVICE_TOKEN_PATH = "/deviceauth/token"
// Shown to the operator. `format!("{base_url}/codex/device")`.
export const OPENAI_DEVICE_VERIFICATION_PATH = "/codex/device"
// The `redirect_uri` a device-issued code is exchanged with at `/oauth/token` — not the loopback.
// `format!("{base_url}/deviceauth/callback")`. Wrong value → the exchange is refused.
export const OPENAI_DEVICE_REDIRECT_PATH = "/deviceauth/callback"
// Used only when the issuer states no interval: codex parses the issuer's string as-is (and would
// spin on 0); opencode falls back to 5 s with `parseInt(interval) || 5`. We take opencode's floor.
export const OPENAI_DEVICE_DEFAULT_INTERVAL_SECONDS = 5

const PENDING_STATUSES: ReadonlySet<number> = new Set([403, 404])

/** codex deserializes `interval` from a string (`"5"`); accept a number too rather than refuse. */
const Interval = z.union([z.string(), z.number()]).transform((value) => {
  const seconds = typeof value === "number" ? value : Number.parseInt(value.trim(), 10)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
})

const UserCodeResponse = z
  .object({
    device_auth_id: z.string().min(1),
    // codex: `#[serde(alias = "user_code", alias = "usercode")]`.
    user_code: z.string().min(1).optional(),
    usercode: z.string().min(1).optional(),
    interval: Interval.optional(),
  })
  .transform((body, ctx) => {
    const userCode = body.user_code ?? body.usercode
    if (userCode === undefined) {
      ctx.addIssue({ code: "custom", message: "no user code" })
      return z.NEVER
    }
    return { deviceAuthId: body.device_auth_id, userCode, intervalSeconds: body.interval ?? null }
  })

// codex `CodeSuccessResp` — `code_challenge` is also sent and not needed for the exchange.
const CodeIssued = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
})

const JSON_HEADERS = { "content-type": "application/json" } as const

export function openAiDeviceFlow(issuer: string, clientId: string): ProviderDeviceFlow {
  const api = accountsApi(issuer)
  return {
    verificationUrl: `${issuer}${OPENAI_DEVICE_VERIFICATION_PATH}`,
    redirectUri: `${issuer}${OPENAI_DEVICE_REDIRECT_PATH}`,
    defaultIntervalSeconds: OPENAI_DEVICE_DEFAULT_INTERVAL_SECONDS,
    userCodeRequest: () => ({
      url: `${api}${OPENAI_DEVICE_USERCODE_PATH}`,
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ client_id: clientId }),
    }),
    readUserCode: (body) => {
      const parsed = UserCodeResponse.safeParse(body)
      return parsed.success ? parsed.data : null
    },
    pollRequest: ({ deviceAuthId, userCode }) => ({
      url: `${api}${OPENAI_DEVICE_TOKEN_PATH}`,
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    }),
    readPoll: (status, body, headers): DevicePollResult => {
      if (PENDING_STATUSES.has(status)) return { kind: "pending" }
      // codex treats every other non-2xx as fatal; a router polling for minutes must not let one
      // overloaded answer spend an attempt the operator is about to approve.
      if (status === 429 || status >= 500) {
        return {
          kind: "retry",
          throttled: status === 429,
          retryAfterSeconds: retryAfterSeconds(headers?.get("retry-after") ?? null),
        }
      }
      if (status < 200 || status >= 300) return { kind: "refused" }
      const parsed = CodeIssued.safeParse(body)
      return parsed.success
        ? {
            kind: "authorized",
            code: parsed.data.authorization_code,
            codeVerifier: parsed.data.code_verifier,
          }
        : { kind: "refused" }
    },
  }
}

/** Delta-seconds only; an HTTP-date `Retry-After` is read as absent and the backoff applies. */
function retryAfterSeconds(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null
  const seconds = Number.parseInt(value.trim(), 10)
  return seconds > 0 ? seconds : null
}
