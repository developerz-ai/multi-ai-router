import { type Dialect, describeError, isRouterError } from "@multi-ai-router/core"
import type { AccountRow } from "@multi-ai-router/db"
import { z } from "zod"
import { type DriverAccount, httpDriver } from "../../providers"
import type { CredentialCipher } from "../crypto/cipher"
import { type FetchLike, type RoutableAccount, runAttempt, upstreamModelsUrl } from "../dataplane"

/**
 * **Ask one upstream what it serves.** One GET, one credential, one answer.
 *
 * Lifted out of `accounts/discover-models.ts` when the hourly catalog sweep needed the same call:
 * two readers of one provider listing must not be two parsers of it, or the operator's button and
 * the sweep would eventually disagree about what an upstream said. The button still owns what it
 * does with the answer — writing `supported_models` is a routing decision and stays there — and
 * this module owns only the asking.
 *
 * It costs no tokens and spends no quota window, which is why the sweep can afford to run hourly
 * and why neither caller carries a cooldown. It is still a real outbound call on a real credential,
 * so it goes through `runAttempt`: same header rules, same credential handling, same failure
 * classification, so a `401` here reports what a `401` on a live request would have.
 */

/**
 * One entry, with whatever the provider said about its size.
 *
 * Both numbers are null far more often than not. Verified against the live endpoints: z.ai,
 * MiniMax, OpenAI and Anthropic answer with an id, an object type and an owner and nothing else.
 * The hosts that serve open-weight models (Groq, Together, Cerebras) and the aggregators do state a
 * size, as do Google and Mistral — which is the entire reason this parser reads a size at all
 * rather than leaving every window to the shipped table.
 */
export interface UpstreamModelEntry {
  readonly id: string
  readonly contextTokens: number | null
  readonly maxOutputTokens: number | null
}

export type ListingFailureCode =
  | "provider_unavailable"
  | "endpoint_unresolved"
  | "discovery_failed"
  | "discovery_unreadable"

export type UpstreamListing =
  | { readonly ok: true; readonly entries: readonly UpstreamModelEntry[] }
  | { readonly ok: false; readonly code: ListingFailureCode; readonly message: string }

export interface UpstreamListingDeps {
  readonly cipher: Pick<CredentialCipher, "decrypt">
  /** Bounds the one outbound call — the same ceiling a normal attempt gets. */
  readonly timeoutMs: number
  readonly fetch: FetchLike
}

/**
 * A positive integer, or null. Everything else — a string, a float, zero, a negative — is read as
 * "this provider did not state a size", because a context window of zero is not a window and a
 * silently coerced `"128000"` would be indistinguishable from a number the provider actually sent.
 */
const size = z
  .unknown()
  .transform((value) =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null,
  )

/**
 * The union of every spelling a provider listing uses for these two numbers, all optional.
 *
 * Provenance, one field at a time, so a reader can tell which vendor each exists for:
 * `context_length` is OpenRouter's and Together's, `context_window` is Groq's, `max_context_length`
 * is Mistral's, and `inputTokenLimit`/`outputTokenLimit` are Google's camelCase pair.
 * `top_provider` is OpenRouter's per-endpoint block, which is the more specific of its two answers.
 *
 * A loose object throughout: a provider adding a field must never fail the listing, and an entry
 * that is malformed in a way this cannot read still yields its id.
 */
const entrySchema = z.looseObject({
  id: z.unknown().optional(),
  context_length: size.optional(),
  context_window: size.optional(),
  max_context_length: size.optional(),
  inputTokenLimit: size.optional(),
  max_completion_tokens: size.optional(),
  max_output_tokens: size.optional(),
  outputTokenLimit: size.optional(),
  top_provider: z
    .looseObject({
      context_length: size.optional(),
      max_completion_tokens: size.optional(),
    })
    .nullish(),
})

const listingSchema = z.object({
  data: z.array(entrySchema),
  /** Anthropic only. True means the page cap below cut the answer short. */
  has_more: z.boolean().optional(),
})

/**
 * Anthropic's listing pages at 20 by default and caps at 1000; OpenAI's does not page at all and
 * ignores the parameter. One page of the documented maximum is therefore the whole catalog for
 * every provider this router knows of.
 */
const PAGE_LIMIT = "1000"

export const NOT_HTTP = "has no HTTP model listing to read"

export async function listUpstreamModels(
  deps: UpstreamListingDeps,
  account: AccountRow,
): Promise<UpstreamListing> {
  const driver = httpDriver(account.provider)
  if (driver === null) {
    return fail("provider_unavailable", `provider "${account.provider}" ${NOT_HTTP}`)
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
    return fail("endpoint_unresolved", messageOf(error))
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
    fetch: deps.fetch,
    cipher: deps.cipher,
    timeoutMs: deps.timeoutMs,
  })

  if (outcome.kind === "failure") {
    return fail(
      "discovery_failed",
      `could not read the model listing: ${
        outcome.classification?.signal ?? `upstream attempt failed (${outcome.failure.kind})`
      }`,
    )
  }

  const parsed = listingSchema.safeParse(await readJson(outcome.response))
  if (!parsed.success) {
    return fail(
      "discovery_unreadable",
      `the upstream's model listing is not in a shape this router recognizes (${dialectNote(dialect)})`,
    )
  }

  return { ok: true, entries: dedupe(parsed.data.data.map(toEntry)) }
}

type ParsedEntry = z.infer<typeof entrySchema>

function toEntry(entry: ParsedEntry): UpstreamModelEntry {
  return {
    id: typeof entry.id === "string" ? entry.id.trim() : "",
    // Most specific first. OpenRouter states both a model-wide `context_length` and a per-endpoint
    // `top_provider.context_length`, and the endpoint block is the one describing what an account
    // pointed at it would actually get.
    contextTokens:
      entry.top_provider?.context_length ??
      entry.context_length ??
      entry.context_window ??
      entry.max_context_length ??
      entry.inputTokenLimit ??
      null,
    maxOutputTokens:
      entry.top_provider?.max_completion_tokens ??
      entry.max_completion_tokens ??
      entry.max_output_tokens ??
      entry.outputTokenLimit ??
      null,
  }
}

/**
 * Deduplicated by id and sorted. An entry with no usable id is dropped rather than failing the
 * whole listing over one malformed row; the first entry for an id wins, because a provider that
 * lists a model twice has already said what it means the first time.
 */
function dedupe(entries: readonly UpstreamModelEntry[]): readonly UpstreamModelEntry[] {
  const byId = new Map<string, UpstreamModelEntry>()
  for (const entry of entries) {
    if (entry.id.length === 0 || byId.has(entry.id)) continue
    byId.set(entry.id, entry)
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function fail(code: ListingFailureCode, message: string): UpstreamListing {
  return { ok: false, code, message }
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
    billing: account.billing,
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
  // The cause chain, not just the wrapper: "fetch failed" alone names nothing an operator can fix.
  const described = describeError(error, Number.POSITIVE_INFINITY)
  return described.length > 0 ? described : "the account's endpoint could not be resolved"
}
