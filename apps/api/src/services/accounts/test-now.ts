import type { AccountRepository } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import type { SdkQuotaStore, SdkTestProbe, UpstreamFailureKind } from "../../providers"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminResult, invalid, notFound, ok } from "../admin/result"
import type { CredentialCipher } from "../crypto/cipher"
import type { FetchLike, HealthStore } from "../dataplane"
import { describeProvider } from "./providers"
import { runHttpProbe, runSdkProbe } from "./test-now-probes"

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
  /**
   * The failure's class, when the attempt named one — the shared routing vocabulary, so a caller
   * (the idle sweep) can tell a spent window from a broken turn without reading `message`'s prose.
   */
  readonly failureKind?: UpstreamFailureKind
  readonly latencyMs?: number
}

export interface TestNowService {
  test(
    accountId: string,
    input: { readonly model: string; readonly confirmed?: boolean },
  ): Promise<AdminResult<TestNowResult>>
  /** Local opt-in test timestamp; independent of durable recovery cooldown. */
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
  /**
   * Where the ingested reading actually becomes visible. The console and routing both read a health
   * snapshot, not the quota store, so a reading that stops at `quota` is a reading nothing renders.
   */
  readonly health?: Pick<HealthStore, "applyRateLimit">
  /**
   * Optional, and only ever used for a **failed** test. A test that fails is the one outcome an
   * operator cannot debug from the response alone — it carries a router-authored sentence by
   * design, so an unrecognized upstream reason reads as "a reason this router does not recognize"
   * with nothing anywhere naming what that reason was. That is a dead end for the operator and for
   * whoever has to add the missing classification rule.
   */
  readonly log?: Pick<Logger, "warn">
}

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

      // A failed test used to leave no trace anywhere but the HTTP response the operator was
      // already looking at. The message is deliberately router-authored, so when the upstream says
      // something this build has no rule for, the *only* copy of what it actually said was the one
      // we discarded. This is the line that makes the next classification rule writable.
      if (!outcome.ok) {
        deps.log?.warn("account test failed", {
          component: "test-now",
          accountId: account.id,
          provider: account.provider,
          model: input.model,
          reason: outcome.message,
          // What the upstream itself said, when it said anything. This is the field that makes an
          // unrecognized failure diagnosable instead of a tautology.
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          latencyMs,
        })
      }

      return ok({
        accountId,
        lastCheckedAt: now.toISOString(),
        nextAllowedAt: new Date(now.getTime() + cooldownMs).toISOString(),
        tested: true,
        outcome: outcome.ok ? "ok" : "failed",
        message: outcome.message,
        ...(outcome.failureKind === undefined ? {} : { failureKind: outcome.failureKind }),
        latencyMs,
      })
    },
  }
}
