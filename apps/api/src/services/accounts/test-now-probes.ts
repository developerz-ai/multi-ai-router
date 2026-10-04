import { type Dialect, isRouterError, type OpenAiChatCeiling } from "@multi-ai-router/core"
import type { AccountRow } from "@multi-ai-router/db"
import {
  type DriverAccount,
  httpDriver,
  type RateLimitSignal,
  type UpstreamFailureKind,
} from "../../providers"
import { UpstreamAdmissionRefused } from "../../providers/upstream-admission"
import { type FetchLike, routableStandIn, runAttempt, upstreamUrl } from "../dataplane"
import { bounded } from "../dataplane/attempt-log"
import {
  applyResponsesEgressRules,
  collectResponsesStream,
  type ResponsesEgressRules,
} from "../translate"
import type { TestNowServiceDeps } from "./test-now"

const NO_SDK_PROBE = "this router has no Agent-SDK test probe configured"

export interface ProbeOutcome {
  readonly admissionRefused?: true
  readonly ok: boolean
  readonly message: string
  /** Raw upstream text, for the log only. Never rendered into the response. */
  readonly detail?: string
  readonly failureKind?: UpstreamFailureKind
}

export async function runSdkProbe(
  deps: TestNowServiceDeps,
  account: AccountRow,
  model: string,
  beforeBackgroundUpstreamStart?: () => Promise<void>,
): Promise<ProbeOutcome> {
  if (deps.sdkProbe === undefined) return { ok: false, message: NO_SDK_PROBE }
  const configDir = account.configDir?.trim()
  if (configDir === undefined || configDir.length === 0) {
    return {
      ok: false,
      message: `account ${account.id} has no config directory — nothing to test yet`,
    }
  }

  // The deadline bounds the wait for a subprocess slot as well as the turn itself: the probe shares
  // the dispatch path's ceiling (`claude-sdk/test-probe.ts`), so a saturated replica answers "at the
  // ceiling" rather than queueing a button press behind live traffic indefinitely.
  let result: Awaited<ReturnType<NonNullable<TestNowServiceDeps["sdkProbe"]>["run"]>>
  try {
    result = await deps.sdkProbe.run({
      accountId: account.id,
      configDir,
      model,
      signal: AbortSignal.timeout(deps.timeoutMs),
      ...(beforeBackgroundUpstreamStart === undefined ? {} : { beforeBackgroundUpstreamStart }),
    })
  } catch (error) {
    if (!(error instanceof UpstreamAdmissionRefused)) throw error
    return {
      ok: false,
      admissionRefused: true,
      message: "background account admission was declined",
    }
  }

  // The turn is already billed and the SDK already volunteered this account's window state, so the
  // readings are folded in exactly as the dispatch path folds them
  // (`services/dataplane/sdk-attempt.ts`). Without this the console's quota windows stayed empty
  // until real traffic happened to route through the account — which is backwards for the button
  // whose entire job is answering "how is this account doing".
  //
  // Oldest first, so the last event of the turn is the one that stands. **Both stores, not one:**
  // `quota.ingest` accumulates the per-account windows, and the resulting signal then goes to the
  // health store — which is what the console and routing actually read (`availability.ts` builds
  // its view from a health snapshot). Ingesting without folding leaves the reading in a store
  // nothing renders, which is the shape this bug took the first time.
  if (deps.quota !== undefined) {
    const now = deps.now()
    let latest: RateLimitSignal | null = null
    // `?? []` because the probe is an injected dependency: a non-conforming one should fold
    // nothing, never throw on the button's own path.
    for (const info of result.rateLimitInfos ?? []) {
      const snapshot = deps.quota.ingest(account.id, info, now)
      if (snapshot !== null) latest = snapshot.signal
    }
    if (latest !== null) deps.health?.applyRateLimit(account.id, latest, now)
  }

  return {
    ok: result.ok,
    message: result.message,
    ...(result.reasonDetail === undefined ? {} : { detail: result.reasonDetail }),
    ...(result.failureKind === undefined ? {} : { failureKind: result.failureKind }),
  }
}

export async function runHttpProbe(
  deps: TestNowServiceDeps,
  call: FetchLike,
  account: AccountRow,
  requestedModel: string,
  beforeBackgroundUpstreamStart?: () => Promise<void>,
): Promise<ProbeOutcome> {
  const driver = httpDriver(account.provider)
  if (driver === null) {
    return { ok: false, message: `provider "${account.provider}" is not served over HTTP` }
  }

  const driverAccount: DriverAccount = {
    id: account.id,
    provider: account.provider,
    baseUrl: account.baseUrl,
    dialect: account.dialect,
    modelAliases: account.modelAliases,
  }
  const dialect = driver.resolveDialect(driverAccount)
  const upstreamModel = driver.mapModelAlias(driverAccount, requestedModel)

  let url: URL
  try {
    url = upstreamUrl(driver, driverAccount, dialect)
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }

  const routable = routableStandIn(account, driverAccount)

  const outcome = await runAttempt({
    plan: { account: routable, driver, dialect, url, upstreamModel },
    method: "POST",
    clientHeaders: new Headers(),
    body: probeBody(
      dialect,
      upstreamModel,
      driver.resolveChatCeiling(driverAccount),
      driver.resolveResponsesEgress(driverAccount),
    ),
    fetch:
      beforeBackgroundUpstreamStart === undefined
        ? call
        : async (request) => {
            await beforeBackgroundUpstreamStart()
            request.signal.throwIfAborted()
            return call(request)
          },
    cipher: deps.cipher,
    timeoutMs: deps.timeoutMs,
  })

  if (outcome.kind === "success") {
    // Never relayed anywhere — this call has no client. Draining it is hygiene, not a translation.
    const raw = await outcome.response.arrayBuffer().catch(() => null)
    const streamed = outcome.response.headers.get("content-type")?.includes("text/event-stream")
    if (streamed === true && dialect === "openai-responses") {
      // A forced stream (`ResponsesEgressRules.requireStream`) answers 200 before it has answered
      // anything; only its terminal event says whether the turn actually completed.
      const final = raw === null ? null : collectResponsesStream(new Uint8Array(raw))
      if (final === null || final.status === "failed") {
        return {
          ok: false,
          message: "upstream stream ended without a completed response",
          failureKind: "server-error",
        }
      }
    }
    return { ok: true, message: `upstream answered ${outcome.response.status}` }
  }

  if (outcome.kind === "admission-refused") {
    return {
      ok: false,
      admissionRefused: true,
      message: "test attempt unavailable: admission was declined before provider dispatch",
    }
  }

  // What the upstream itself said — already scrubbed of this account's credential by `runAttempt`,
  // bounded to the configured length, and for the log line only (`ProbeOutcome.detail`).
  const upstreamMessage =
    deps.reasonMaxChars === undefined
      ? undefined
      : bounded(outcome.classification?.message, deps.reasonMaxChars)
  return {
    ok: false,
    message: outcome.classification?.signal ?? `upstream attempt failed (${outcome.failure.kind})`,
    ...(outcome.classification?.kind === undefined
      ? {}
      : { failureKind: outcome.classification.kind }),
    ...(upstreamMessage === undefined || upstreamMessage.length === 0
      ? {}
      : { detail: upstreamMessage }),
  }
}

/**
 * The smallest real call each dialect states. openai-chat's ceiling is the one field two vendors
 * name differently, and the account's own driver says which — an OpenAI reasoning model answers the
 * other name with a `400` the operator would read as "this account is broken"
 * (docs/idea/06-protocol-translation.md#the-output-ceiling-one-field-two-names).
 */
function probeBody(
  dialect: Dialect,
  model: string,
  ceiling: OpenAiChatCeiling,
  responses: ResponsesEgressRules,
): Uint8Array {
  const text = new TextEncoder()
  if (dialect === "openai-responses") {
    // The surface's own rules, exactly as a translated request gets them: the Codex backend refuses
    // a ceiling, a non-streaming call and a missing `instructions` (`translate/shared/responses-egress.ts`).
    const body = { model, input: "ping", max_output_tokens: 16, store: false }
    return text.encode(JSON.stringify(applyResponsesEgressRules(body, responses, undefined)))
  }
  if (dialect === "anthropic") {
    return text.encode(
      JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    )
  }
  return text.encode(
    JSON.stringify({
      model,
      [ceiling]: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
  )
}

function messageOf(error: unknown): string {
  if (isRouterError(error)) return error.message
  return error instanceof Error ? error.message : "the account's endpoint could not be resolved"
}
