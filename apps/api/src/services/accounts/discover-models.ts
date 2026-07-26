import { type Dialect, isRouterError } from "@multi-ai-router/core"
import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import { z } from "zod"
import { type DriverAccount, httpDriver } from "../../providers"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminResult, invalid, notFound, ok } from "../admin/result"
import type { CredentialCipher } from "../crypto/cipher"
import { type FetchLike, type RoutableAccount, runAttempt, upstreamModelsUrl } from "../dataplane"
import { describeProvider } from "./providers"
import type { AccountsService } from "./service"

/**
 * **Ask the upstream what it serves**, and write the answer into `supported_models`.
 *
 * Until this existed the column had no way to be filled except by hand, and before the column
 * existed `supportedModels` was declared by routing and populated by nothing at all — so every
 * account was a passthrough and `GET /v1/models` answered `data: []` on any deployment without an
 * alias map. A client filling a model picker from that listing saw an empty router.
 *
 * **One button, one GET, and it costs no tokens** — which is the whole reason it is not "Test now".
 * A models listing bills nothing and spends no quota window, so it carries no cooldown and no
 * confirmation. It is still a real outbound call on a real credential, so it goes through
 * `runAttempt`: same header rules, same credential handling, same failure classification, so a 401
 * here reports what a 401 on a live request would have.
 *
 * **It is not a poll, and there is no timer.** A catalog that refreshed itself would change routing
 * without an operator ever asking — an upstream retiring a model would silently take an account out
 * of selection mid-deployment. Discovery happens when a human presses the button.
 *
 * **The write goes through {@link AccountsService.update}**, not the repository: that is what keeps
 * the warm routing catalog coherent (the `withCatalogRefresh` decorator wraps it) and what audits
 * the field change. This service owns the question; it does not own the row.
 *
 * **An empty listing is never saved.** A provider that answers `data: []` — or one whose listing
 * this router cannot read — must not be allowed to turn "I know of no models" into "this account
 * serves no models", which is what writing `[]` would eventually mean to a reader who forgot that
 * empty is passthrough. Nothing is written and the operator is told what came back.
 */

/**
 * Both dialects word their listing the same way: an array under `data`, each entry carrying an
 * `id`. Anthropic adds `type`/`display_name`, OpenAI adds `object`/`owned_by`, and neither is
 * needed here — an entry with anything else on it is kept, an entry with no usable `id` is dropped
 * rather than failing the whole listing over one malformed row.
 */
const modelListing = z.object({
  data: z.array(z.looseObject({ id: z.unknown().optional() })),
  /** Anthropic only. True means the page cap below cut the answer short. */
  has_more: z.boolean().optional(),
})

/**
 * Anthropic's listing pages at 20 by default and caps at 1000; OpenAI's does not page at all and
 * ignores the parameter. One page of the documented maximum is therefore the whole catalog for
 * every provider this router knows of — and `has_more` is relayed rather than followed, because a
 * provider with more than a thousand models is a surprise an operator should be told about, not one
 * this button should quietly spend twenty round trips on.
 */
const PAGE_LIMIT = "1000"

const NOT_HTTP = "has no HTTP model listing to read"
const SDK_OWNS_IT =
  "a Claude subscription has no model listing endpoint — the Agent SDK owns that catalog, and the models it serves are the ones Anthropic gives the subscription"

export interface DiscoverModelsResult {
  readonly accountId: string
  /** Upstream-side ids, deduplicated and sorted. Empty when the upstream listed nothing. */
  readonly models: readonly string[]
  /** False when there was nothing to write — an empty listing is not a declaration. */
  readonly saved: boolean
  /** Always safe to render: router-authored, or a `FailureClassification.signal`. */
  readonly message: string
  readonly latencyMs: number
}

export interface DiscoverModelsService {
  discover(accountId: string): Promise<AdminResult<DiscoverModelsResult>>
}

export interface DiscoverModelsServiceDeps {
  readonly accounts: Pick<AccountRepository, "findById">
  /**
   * The decorated service, so the write refreshes the warm catalog and writes its own audit row.
   * Deliberately not the repository — see the note above.
   */
  readonly write: Pick<AccountsService, "update">
  readonly cipher: Pick<CredentialCipher, "decrypt">
  readonly audit: AuditRecorder
  /** Bounds the one outbound call — the same ceiling a normal attempt gets. */
  readonly timeoutMs: number
  /** Injected so a test never opens a socket. Defaults to global `fetch`. */
  readonly fetch?: FetchLike
}

export function createDiscoverModelsService(
  deps: DiscoverModelsServiceDeps,
): DiscoverModelsService {
  const call = deps.fetch ?? ((request: Request) => fetch(request))

  return {
    discover: async (accountId) => {
      const account = await deps.accounts.findById(accountId)
      if (account === undefined) return notFound(`no account with id "${accountId}"`)

      const descriptor = describeProvider(account.provider)
      if (descriptor.transport === "agent-sdk") {
        return invalid(`account "${account.label}": ${SDK_OWNS_IT}`, "models_not_listable")
      }
      if (descriptor.transport === "unimplemented") {
        return invalid(
          `provider "${account.provider}" has no implementation to ask`,
          "provider_unavailable",
        )
      }

      const started = performance.now()
      const listed = await listModels(deps, call, account)
      const latencyMs = Math.round(performance.now() - started)
      if (!listed.ok) return listed

      const models = listed.value
      await deps.audit.record({
        kind: AUDIT_KINDS.accountModelsDiscovered,
        subjectType: AUDIT_SUBJECTS.account,
        subjectId: account.id,
        // A count and a flag. Model ids are not credentials, but the audit log is a log of what
        // happened, not a second copy of the row the write already recorded.
        detail: { provider: account.provider, count: models.length, saved: models.length > 0 },
      })

      if (models.length === 0) {
        return ok({
          accountId,
          models,
          saved: false,
          message:
            "the upstream listed no models — nothing was written, so this account still accepts any model name",
          latencyMs,
        })
      }

      const written = await deps.write.update(accountId, { supportedModels: [...models] })
      if (!written.ok) return written

      return ok({
        accountId,
        models,
        saved: true,
        message: `the upstream listed ${models.length} model(s); this account now accepts only those`,
        latencyMs,
      })
    },
  }
}

/** The one outbound call, and what it said. Upstream-side ids, deduplicated and sorted. */
async function listModels(
  deps: DiscoverModelsServiceDeps,
  call: FetchLike,
  account: AccountRow,
): Promise<AdminResult<readonly string[]>> {
  const driver = httpDriver(account.provider)
  if (driver === null) {
    return invalid(`provider "${account.provider}" ${NOT_HTTP}`, "provider_unavailable")
  }

  const driverAccount: DriverAccount = {
    id: account.id,
    provider: account.provider,
    baseUrl: account.baseUrl,
    dialect: account.dialect,
    modelAliases: account.modelAliases,
  }
  const dialect = driver.resolveDialect(driverAccount)

  let url: URL
  try {
    url = upstreamModelsUrl(driver, driverAccount, dialect)
  } catch (error) {
    return invalid(messageOf(error), "endpoint_unresolved")
  }
  url.searchParams.set("limit", PAGE_LIMIT)

  const outcome = await runAttempt({
    plan: {
      account: routableStandIn(account, driverAccount),
      driver,
      dialect,
      url,
      // A listing names no model. `runAttempt` never reads this field — it exists for the usage
      // record a real request writes, and this call writes none.
      upstreamModel: "",
    },
    method: "GET",
    clientHeaders: new Headers(),
    body: null,
    fetch: call,
    cipher: deps.cipher,
    timeoutMs: deps.timeoutMs,
  })

  if (outcome.kind === "failure") {
    return invalid(
      `could not read the model listing: ${
        outcome.classification?.signal ?? `upstream attempt failed (${outcome.failure.kind})`
      }`,
      "discovery_failed",
    )
  }

  const parsed = modelListing.safeParse(await readJson(outcome.response))
  if (!parsed.success) {
    return invalid(
      `the upstream's model listing is not in a shape this router recognizes (${dialectNote(dialect)})`,
      "discovery_unreadable",
    )
  }

  const ids = parsed.data.data
    .map((entry) => (typeof entry.id === "string" ? entry.id.trim() : ""))
    .filter((id) => id.length > 0)

  return ok([...new Set(ids)].sort((left, right) => left.localeCompare(right)))
}

/**
 * A single-account stand-in for the routing view `runAttempt` expects. Only `.id` and
 * `.authMaterial` are ever read on this path (`egress/credential.ts`) — everything else is present
 * only to satisfy the shape, never inspected.
 */
function routableStandIn(account: AccountRow, driverAccount: DriverAccount): RoutableAccount {
  return {
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
    authMaterial: account.authMaterial,
    configDir: account.configDir,
  }
}

function dialectNote(dialect: Dialect): string {
  return `expected a "data" array of objects with an "id", as the ${dialect} listing returns`
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function messageOf(error: unknown): string {
  if (isRouterError(error)) return error.message
  return error instanceof Error ? error.message : "the account's endpoint could not be resolved"
}
