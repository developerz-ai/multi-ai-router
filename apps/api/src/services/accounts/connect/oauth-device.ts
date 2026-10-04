import { randomBytes, randomUUID } from "node:crypto"
import type { AccountRepository, OauthStateRepository } from "@multi-ai-router/db"
import { z } from "zod"
import type { Logger } from "../../../logging/logger"
import type { OAuthTokenRequest, ProviderDeviceFlow } from "../../../providers"
import { type AdminResult, invalid, ok } from "../../admin/result"
import type { CredentialCipher } from "../../crypto/cipher"
import { sendIssuerRequest } from "./issuer-request"
import { bindConsumed, connectableAccount, STATE_REJECTED } from "./oauth-binding"
import {
  completeAuthorization,
  type OAuthConnectCompleted,
  type OAuthExchangeDeps,
} from "./oauth-exchange"

/**
 * Device-code sign-in: the router asks the issuer for a user code, the operator enters it at the
 * issuer's page from any browser, and the router polls until the issuer hands back a code.
 *
 * **Polling is advanced by the console's status poll, not by a timer.** Each
 * `GET /:id/connect/device` makes at most one upstream poll, single-flighted per attempt and held
 * to the issuer's interval. Nothing to keep alive, nothing lost on restart (the attempt is in
 * Postgres; any replica can advance it), and an unwatched attempt costs the issuer nothing.
 * Bounded by the one-shot TTL (`env.retention.oauthStateMinutes`).
 *
 * **Same state, same fences, same writer.** An ordinary `oauth_states` row bound through
 * `authorization_attempt_id` and its lifecycle version; the issuer's handle and the user code ride
 * sealed in its `nonce` column. Approval consumes the state, re-checks the binding
 * (`oauth-binding.ts`), and writes through `completeAuthorization`, fenced again on both.
 *
 * Never returned or logged: the issuer's `device_auth_id`, the code, the verifier, tokens.
 */

export interface DeviceConnectStarted {
  readonly accountId: string
  readonly mode: "connect" | "reconnect"
  readonly verificationUrl: string
  readonly userCode: string
  readonly expiresAt: string
  readonly intervalSeconds: number
}

export type DeviceConnectStatus =
  | ({ readonly status: "waiting" } & DeviceConnectStarted)
  | { readonly status: "connected"; readonly completed: OAuthConnectCompleted }
  /** No live device attempt: timed out, cancelled, superseded, or already spent. */
  | { readonly status: "expired"; readonly accountId: string }
  /** The issuer refused it — the operator declined, or the issuer ended it. Final. */
  | { readonly status: "denied"; readonly accountId: string }

export interface DeviceConnectService {
  begin(
    accountId: string,
    mode: "connect" | "reconnect",
  ): Promise<AdminResult<DeviceConnectStarted>>
  status(accountId: string): Promise<AdminResult<DeviceConnectStatus>>
}

export interface DeviceConnectDeps extends OAuthExchangeDeps {
  readonly accounts: Pick<
    AccountRepository,
    "findById" | "beginAccountAuthorization" | "commitAuthorization"
  >
  readonly states: Pick<OauthStateRepository, "consume" | "findLive">
  readonly cipher: Pick<CredentialCipher, "encrypt" | "decrypt">
  readonly stateMinutes: number
  /** One info line when a sign-in lands. Ids and status only — never a code, handle or token. */
  readonly log?: Pick<Logger, "info">
}

/** What the encrypted `nonce` holds for a device attempt. */
const Handle = z.object({
  deviceAuthId: z.string().min(1),
  userCode: z.string().min(1),
  intervalSeconds: z.number().positive(),
})
type Handle = z.infer<typeof Handle>

interface AttemptTrack {
  inFlight: Promise<AdminResult<DeviceConnectStatus>> | null
  nextPollAt: number
  /** Doubles on each throttled answer, up to {@link MAX_BACKOFF}; resets on any other answer. */
  backoff: number
  /**
   * The attempt's outcome once it has one — including a failure after the state was spent (a
   * refused exchange, or a credential saved while routing could not be refreshed). Repeated
   * verbatim, so the console never sees a spent attempt turn into "expired".
   */
  final: AdminResult<DeviceConnectStatus> | null
  readonly expiresAt: number
}

/** The ceiling on throttled backoff, as a multiple of the issuer's interval. */
const MAX_BACKOFF = 4

export function createDeviceConnectService(deps: DeviceConnectDeps): DeviceConnectService {
  const ttlMs = deps.stateMinutes * 60_000
  /** Per attempt id. Pruned past expiry, so it holds at most the attempts of the last TTL. */
  const tracks = new Map<string, AttemptTrack>()
  /** Each account's latest attempt: a connected login clears the row's attempt id, not its answer. */
  const latest = new Map<string, string>()

  const send = (built: OAuthTokenRequest) => sendIssuerRequest(deps, built)

  const prune = (now: number) => {
    for (const [id, track] of tracks) if (track.expiresAt <= now) tracks.delete(id)
    for (const [account, id] of latest) if (!tracks.has(id)) latest.delete(account)
  }

  const deviceOf = async (accountId: string) => {
    const account = await connectableAccount(deps.accounts, accountId)
    if (!account.ok) return account
    const device = account.value.flow.device
    if (device === undefined) {
      return invalid(
        `account "${account.value.row.label}": ${account.value.row.provider} offers no device-code sign-in`,
        "device_unavailable",
      )
    }
    return ok({ ...account.value, device })
  }

  const begin: DeviceConnectService["begin"] = async (accountId, mode) => {
    const account = await deviceOf(accountId)
    if (!account.ok) return account
    const { row, device } = account.value

    const answer = await send(device.userCodeRequest())
    if (answer === null) {
      return invalid(
        "the provider's device sign-in could not be reached — try again",
        "device_unreachable",
      )
    }
    if (answer.status === 404) {
      return invalid(
        "the provider has not enabled device sign-in for this client",
        "device_unavailable",
      )
    }
    const code =
      answer.status >= 200 && answer.status < 300 ? device.readUserCode(answer.body) : null
    if (code === null) {
      return invalid(
        `the provider refused the device sign-in request (HTTP ${answer.status})`,
        "device_refused",
      )
    }

    const handle: Handle = {
      deviceAuthId: code.deviceAuthId,
      userCode: code.userCode,
      intervalSeconds: code.intervalSeconds ?? device.defaultIntervalSeconds,
    }
    const now = deps.now()
    const expiresAt = new Date(now.getTime() + ttlMs)
    const begun = await deps.accounts.beginAccountAuthorization({
      id: accountId,
      expectedProvider: row.provider,
      attempt: {
        id: randomUUID(),
        state: randomBytes(32).toString("base64url"),
        // Never presented anywhere: the issuer mints the verifier for a device code itself.
        codeVerifier: deps.cipher.encrypt(randomBytes(32).toString("base64url")),
        nonce: deps.cipher.encrypt(JSON.stringify(handle)),
        redirectUri: device.redirectUri,
        expiresAt,
      },
      now,
    })
    if (begun === undefined) return invalid(STATE_REJECTED, "state_rejected")
    return ok(started(accountId, mode, device, handle, expiresAt))
  }

  const status: DeviceConnectService["status"] = async (accountId) => {
    const now = deps.now()
    prune(now.getTime())
    const account = await deviceOf(accountId)
    if (!account.ok) return account
    const { row, device } = account.value
    const attemptId = row.authorizationAttemptId
    const finished = tracks.get(attemptId ?? latest.get(accountId) ?? "")?.final
    if (finished != null) return finished

    const pending = attemptId === null ? undefined : await deps.states.findLive(attemptId, now)
    const handle = pending?.nonce == null ? null : readHandle(pending.nonce)
    if (pending === undefined || handle === null) return ok({ status: "expired", accountId })

    const track: AttemptTrack = tracks.get(pending.id) ?? {
      inFlight: null,
      nextPollAt: 0,
      backoff: 1,
      final: null,
      expiresAt: pending.expiresAt.getTime(),
    }
    tracks.set(pending.id, track)
    latest.set(accountId, pending.id)
    if (track.inFlight !== null) return track.inFlight
    const mode = row.authMaterial === null ? "connect" : "reconnect"
    const waiting = {
      status: "waiting" as const,
      ...started(accountId, mode, device, handle, pending.expiresAt),
    }
    if (now.getTime() < track.nextPollAt) return ok(waiting)

    track.nextPollAt = now.getTime() + handle.intervalSeconds * 1_000
    track.inFlight = poll(device, pending.state, handle, accountId, waiting, track).finally(() => {
      track.inFlight = null
    })
    const result = await track.inFlight
    if (!result.ok || result.value.status !== "waiting") track.final = result
    return result
  }

  const poll = async (
    device: ProviderDeviceFlow,
    state: string,
    handle: Handle,
    accountId: string,
    waiting: DeviceConnectStatus,
    track: AttemptTrack,
  ): Promise<AdminResult<DeviceConnectStatus>> => {
    const answer = await send(device.pollRequest(handle))
    // A transport blip is not an answer. The TTL bounds how long "waiting" can last.
    if (answer === null) return ok(waiting)
    const read = device.readPoll(answer.status, answer.body, answer.headers)
    if (read.kind === "retry") {
      // Overloaded, not refused: keep waiting. Throttled means slow down — the issuer's own
      // Retry-After when it gave one, otherwise the interval doubled per answer, capped.
      if (read.throttled) {
        track.backoff = Math.min(track.backoff * 2, MAX_BACKOFF)
        const delay = read.retryAfterSeconds ?? handle.intervalSeconds * track.backoff
        track.nextPollAt = deps.now().getTime() + delay * 1_000
      }
      return ok(waiting)
    }
    track.backoff = 1
    if (read.kind === "pending") return ok(waiting)

    // Final either way, so the state is spent either way: one-shot means once.
    const consumed = await deps.states.consume(state, deps.now())
    if (read.kind === "refused") {
      return ok(
        consumed === undefined ? { status: "expired", accountId } : { status: "denied", accountId },
      )
    }
    const bound = await bindConsumed(deps.accounts, consumed, accountId)
    if (!bound.ok) return ok({ status: "expired", accountId })
    const { row, flow, pending, lifecycleVersion } = bound.value
    const completed = await completeAuthorization(deps, {
      row,
      flow,
      attemptId: pending.id,
      expectedLifecycleVersion: lifecycleVersion,
      code: read.code,
      redirectUri: device.redirectUri,
      codeVerifier: read.codeVerifier,
      capture: "device",
    })
    if (!completed.ok) return completed
    deps.log?.info("device login completed", {
      component: "connect",
      accountId,
      provider: row.provider,
      capture: "device",
      previousStatus: row.status,
    })
    return ok({ status: "connected", completed: completed.value })
  }

  const readHandle = (sealed: string): Handle | null => {
    try {
      const parsed = Handle.safeParse(JSON.parse(deps.cipher.decrypt(sealed)))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  return { begin, status }
}

function started(
  accountId: string,
  mode: "connect" | "reconnect",
  device: ProviderDeviceFlow,
  handle: Handle,
  expiresAt: Date,
): DeviceConnectStarted {
  return {
    accountId,
    mode,
    verificationUrl: device.verificationUrl,
    userCode: handle.userCode,
    expiresAt: expiresAt.toISOString(),
    intervalSeconds: handle.intervalSeconds,
  }
}
