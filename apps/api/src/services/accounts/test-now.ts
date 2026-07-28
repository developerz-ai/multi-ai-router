import { type Dialect, isRouterError, type OpenAiChatCeiling } from "@multi-ai-router/core"
import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import {
  type DriverAccount,
  httpDriver,
  type SdkQuotaStore,
  type SdkTestProbe,
} from "../../providers"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminResult, invalid, notFound, ok } from "../admin/result"
import type { CredentialCipher } from "../crypto/cipher"
import { type FetchLike, type RoutableAccount, runAttempt, upstreamUrl } from "../dataplane"
import { describeProvider } from "./providers"

/**
 * The operator's **Test now** — a second, opt-in button beside "Re-check now"
 * (`recheck.ts`), and a deliberately different kind of answer.
 *
 * A re-check clears breaker marks and reports nothing about whether the account actually works,
 * because it sends nothing. This is the button for the question a re-check cannot answer: "does
 * this credential actually complete a request?" It addresses **this one account directly** —
 * bypassing pool membership, key scope, and failover entirely, the same way `recheck.ts` reaches
 * past routing to touch one row — and sends the smallest real request the account's dialect can
 * make: one user turn, capped output.
 *
 * **It costs something, every time, and that is why it is not the default.** An HTTP account
 * spends a token or two of a real quota window; a Claude subscription spends a turn *and* spawns a
 * subprocess, which is why that path additionally refuses to run without `confirmed: true` on the
 * request — CLAUDE.md's "never on the Agent-SDK path without an explicit confirm" is enforced here,
 * not trusted to the console. The subprocess is bounded by the replica's own ceiling, not by this
 * button: the cooldown below is per Account and would not stop ten Accounts being tested at once,
 * so the probe takes a slot from the dispatch path's gate (`claude-sdk/test-probe.ts`).
 *
 * **Its own cooldown, not the re-check's.** Sharing one would let a free button's press block a
 * paid one's, or the reverse — an operator rechecking five accounts in a row must never find the
 * sixth "Test now" already spent. See `env.accountTestNowCooldownSeconds`.
 *
 * **The HTTP half reuses the real attempt path.** `runAttempt` is the same function a live request
 * takes — same header rules, same credential handling, same failure classification — addressed at
 * exactly one account instead of a failover chain, so what this button reports is not a second
 * opinion invented for the console but the one true answer the data plane itself would have gotten.
 */

export interface TestNowResult {
  readonly accountId: string
  readonly lastCheckedAt: string
  readonly nextAllowedAt: string
  /** False when the cooldown declined this press — a success, exactly like `RecheckResult`. */
  readonly tested: boolean
  /** Present only when `tested` is true: what the one real request answered. */
  readonly outcome?: "ok" | "failed"
  /**
   * Always safe to render: a router-authored sentence, the account's own short reply, or a
   * `FailureClassification.signal` — never a raw upstream body, a path, or a session id.
   */
  readonly message?: string
  readonly latencyMs?: number
}

export interface TestNowService {
  test(
    accountId: string,
    input: { readonly model: string; readonly confirmed?: boolean },
  ): Promise<AdminResult<TestNowResult>>
  /** Mirrors `RecheckService.lastCheckedAt` — synchronous, in-memory, for the accounts list. */
  lastCheckedAt(accountId: string): Date | null
}

export interface TestNowServiceDeps {
  readonly accounts: Pick<AccountRepository, "findById">
  readonly cipher: Pick<CredentialCipher, "decrypt">
  readonly audit: AuditRecorder
  readonly cooldownSeconds: number
  /** Bounds the one outbound call — the same ceiling a normal attempt gets. */
  readonly timeoutMs: number
  readonly now: () => Date
  /** Injected so a test never opens a socket. Defaults to global `fetch`. */
  readonly fetch?: FetchLike
  /**
   * The Agent-SDK half. Omitted means a Claude subscription's test is refused by name rather than
   * silently doing nothing — the same rule `DispatcherDeps.invokeSdk` follows for the real path.
   */
  readonly sdkProbe?: SdkTestProbe
  /**
   * The **same** quota store the dispatch path writes to, so a tested account's windows are the
   * windows routing reads — never a second copy that could disagree. Omitted means the readings are
   * discarded, which is what this service did for every account before: correct, and useless.
   */
  readonly quota?: Pick<SdkQuotaStore, "ingest">
}

const NO_SDK_PROBE = "this router has no Agent-SDK test probe configured"
const CONFIRMATION_REQUIRED =
  "testing a Claude subscription spawns a real claude subprocess and bills a turn — resend with confirmed: true"

export function createTestNowService(deps: TestNowServiceDeps): TestNowService {
  const lastChecked = new Map<string, Date>()
  const cooldownMs = deps.cooldownSeconds * 1_000
  const call = deps.fetch ?? ((request: Request) => fetch(request))

  const refused = (accountId: string, previous: Date): TestNowResult => ({
    accountId,
    lastCheckedAt: previous.toISOString(),
    nextAllowedAt: new Date(previous.getTime() + cooldownMs).toISOString(),
    tested: false,
  })

  return {
    lastCheckedAt: (accountId) => lastChecked.get(accountId) ?? null,

    test: async (accountId, input) => {
      const account = await deps.accounts.findById(accountId)
      if (account === undefined) return notFound("No account has that id")

      const descriptor = describeProvider(account.provider)
      if (descriptor.transport === "unimplemented") {
        return invalid(
          `provider "${account.provider}" has no implementation to test`,
          "provider_unavailable",
        )
      }
      if (descriptor.transport === "agent-sdk" && input.confirmed !== true) {
        return invalid(CONFIRMATION_REQUIRED, "confirmation_required")
      }

      const now = deps.now()
      const previous = lastChecked.get(accountId)
      if (previous !== undefined && now.getTime() - previous.getTime() < cooldownMs) {
        return ok(refused(accountId, previous))
      }
      lastChecked.set(accountId, now)

      const started = performance.now()
      const outcome =
        descriptor.transport === "agent-sdk"
          ? await runSdkProbe(deps, account, input.model)
          : await runHttpProbe(deps, call, account, input.model)
      const latencyMs = Math.round(performance.now() - started)

      await deps.audit.record({
        kind: AUDIT_KINDS.accountTested,
        subjectType: AUDIT_SUBJECTS.account,
        subjectId: account.id,
        detail: { provider: account.provider, outcome: outcome.ok ? "ok" : "failed" },
      })

      return ok({
        accountId,
        lastCheckedAt: now.toISOString(),
        nextAllowedAt: new Date(now.getTime() + cooldownMs).toISOString(),
        tested: true,
        outcome: outcome.ok ? "ok" : "failed",
        message: outcome.message,
        latencyMs,
      })
    },
  }
}

interface ProbeOutcome {
  readonly ok: boolean
  readonly message: string
}

async function runSdkProbe(
  deps: TestNowServiceDeps,
  account: AccountRow,
  model: string,
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
  const result = await deps.sdkProbe.run({
    accountId: account.id,
    configDir,
    model,
    signal: AbortSignal.timeout(deps.timeoutMs),
  })

  // The turn is already billed and the SDK already volunteered this account's window state, so the
  // readings are folded in exactly as the dispatch path folds them
  // (`services/dataplane/sdk-attempt.ts`). Without this the console's quota windows stayed empty
  // until real traffic happened to route through the account — which is backwards for the button
  // whose entire job is answering "how is this account doing".
  //
  // Oldest first, so the last event of the turn is the one that stands.
  if (deps.quota !== undefined) {
    const now = deps.now()
    for (const info of result.rateLimitInfos) deps.quota.ingest(account.id, info, now)
  }

  return { ok: result.ok, message: result.message }
}

async function runHttpProbe(
  deps: TestNowServiceDeps,
  call: FetchLike,
  account: AccountRow,
  requestedModel: string,
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

  // A single-account stand-in for the routing view `runAttempt` expects. Only `.id` and
  // `.authMaterial` are ever read on this path (`egress/credential.ts`) — everything else here is
  // present only to satisfy the shape, never inspected.
  const routable: RoutableAccount = {
    id: account.id,
    snapshot: {
      id: account.id,
      label: account.label,
      provider: account.provider,
      status: account.status,
      weight: account.weight,
      priority: account.priority,
      health: { consecutiveFailures: 0, inFlight: 0, recentTokens: 0 },
    },
    driver: driverAccount,
    billing: account.billing,
    authMaterial: account.authMaterial,
    configDir: account.configDir,
  }

  const outcome = await runAttempt({
    plan: { account: routable, driver, dialect, url, upstreamModel },
    method: "POST",
    clientHeaders: new Headers(),
    body: probeBody(dialect, upstreamModel, driver.resolveChatCeiling(driverAccount)),
    fetch: call,
    cipher: deps.cipher,
    timeoutMs: deps.timeoutMs,
  })

  if (outcome.kind === "success") {
    // Never relayed anywhere — this call has no client. Draining it is hygiene, not a translation.
    await outcome.response.text().catch(() => undefined)
    return { ok: true, message: `upstream answered ${outcome.response.status}` }
  }

  return {
    ok: false,
    message: outcome.classification?.signal ?? `upstream attempt failed (${outcome.failure.kind})`,
  }
}

/**
 * The smallest real call each dialect states. openai-chat's ceiling is the one field two vendors
 * name differently, and the account's own driver says which — an OpenAI reasoning model answers the
 * other name with a `400` the operator would read as "this account is broken"
 * (docs/idea/06-protocol-translation.md#the-output-ceiling-one-field-two-names).
 */
function probeBody(dialect: Dialect, model: string, ceiling: OpenAiChatCeiling): Uint8Array {
  const text = new TextEncoder()
  if (dialect === "openai-responses") {
    return text.encode(JSON.stringify({ model, input: "ping", max_output_tokens: 16 }))
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
