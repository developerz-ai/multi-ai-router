import {
  type Dialect,
  describeError,
  isRouterError,
  type ModelReasoning,
} from "@multi-ai-router/core"
import type { AccountRow } from "@multi-ai-router/db"
import { type DriverAccount, httpDriver } from "../../providers"
import type { CredentialCipher } from "../crypto/cipher"
import { type FetchLike, routableStandIn, runAttempt, upstreamModelsUrl } from "../dataplane"
import { DEFAULT_LISTING_MAX_BYTES, readJsonCapped } from "./capped-json"
import { dedupe, listingSchema, toEntry } from "./listing-parse"

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
 * Both numbers are null more often than not: z.ai, MiniMax and OpenAI answer with an id, an object
 * type and an owner and nothing else. Anthropic's `ModelInfo` now states `max_input_tokens` and
 * `max_tokens` (`number | null`, @anthropic-ai/sdk 0.131), the hosts that serve open-weight models
 * (Groq, Together, Cerebras, vLLM) and the aggregators state a size, and so does Mistral — which is
 * the entire reason this parser reads a size at all rather than leaving every window to the shipped
 * table.
 */
export interface UpstreamModelEntry {
  readonly id: string
  readonly contextTokens: number | null
  readonly maxOutputTokens: number | null
  /** Only a driver with its own listing states this; the stock reader never does. */
  readonly reasoning?: ModelReasoning
}

export type ListingFailureCode =
  | "provider_unavailable"
  | "endpoint_unresolved"
  | "discovery_failed"
  | "discovery_unreadable"

export type UpstreamListing =
  | {
      readonly ok: true
      readonly entries: readonly UpstreamModelEntry[]
      /** The upstream said there is more past the one page asked for (`has_more`). */
      readonly truncated?: true
    }
  | {
      readonly ok: false
      readonly code: ListingFailureCode
      readonly message: string
      /**
       * The HTTP status the upstream answered with, when it answered at all. Absent on a transport
       * failure and on every failure that happened before a socket opened. Carried apart from the
       * message so a caller can tell "this endpoint has no listing" (`404`/`405`) from "this
       * credential is dead" (`401`) without parsing prose.
       */
      readonly status?: number
      /**
       * What the upstream itself said, already scrubbed of the account's credential by
       * `runAttempt`. For the log line only — never rendered into a response; unbounded here.
       */
      readonly detail?: string
    }

export interface UpstreamListingDeps {
  readonly cipher: Pick<CredentialCipher, "decrypt">
  /** Bounds the one outbound call — the same ceiling a normal attempt gets. */
  readonly timeoutMs: number
  readonly fetch: FetchLike
  /** Ceiling on the listing body (`MODEL_LISTING_MAX_BYTES`). Default {@link DEFAULT_LISTING_MAX_BYTES}. */
  readonly maxResponseBytes?: number
}

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
  // A driver may read its listing off another of its surfaces (`ProviderModelListing.dialect`): the
  // URL, the headers and the parse are that surface's, and an operator's base URL still wins.
  const listingDialect = driver.modelListing?.dialect
  const listedAccount: DriverAccount =
    listingDialect === undefined ? driverAccount : { ...driverAccount, dialect: listingDialect }
  const dialect = driver.resolveDialect(listedAccount)

  let url: URL
  try {
    url = upstreamModelsUrl(driver, listedAccount, dialect)
  } catch (error) {
    return fail("endpoint_unresolved", messageOf(error))
  }
  // A driver with its own listing states its own query (`providers/model-listing.ts`).
  const listing = driver.modelListing
  if (listing === undefined) url.searchParams.set("limit", PAGE_LIMIT)
  else
    for (const [name, value] of Object.entries(listing.query())) url.searchParams.set(name, value)

  const outcome = await runAttempt({
    plan: {
      account: routableStandIn(account, listedAccount),
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

  if (outcome.kind === "admission-refused")
    return fail("discovery_failed", "model discovery is awaiting upstream admission")
  if (outcome.kind === "failure") {
    return fail(
      "discovery_failed",
      `could not read the model listing: ${
        outcome.classification?.signal ?? `upstream attempt failed (${outcome.failure.kind})`
      }`,
      outcome.upstream?.status,
      outcome.classification?.message,
    )
  }

  const body = await readJsonCapped(
    outcome.response,
    deps.maxResponseBytes ?? DEFAULT_LISTING_MAX_BYTES,
  )
  if (!body.ok && body.reason === "too-large") {
    return fail(
      "discovery_unreadable",
      `the upstream's model listing is larger than ${deps.maxResponseBytes ?? DEFAULT_LISTING_MAX_BYTES} bytes`,
    )
  }
  const json = body.ok ? body.value : undefined

  if (listing !== undefined) {
    const read = listing.read(json)
    return read === null
      ? fail(
          "discovery_unreadable",
          "the upstream's model listing is not in the shape its driver declares",
        )
      : { ok: true, entries: dedupe(read.map((entry) => ({ ...entry, id: entry.id.trim() }))) }
  }

  const parsed = listingSchema.safeParse(json)
  if (!parsed.success) {
    return fail(
      "discovery_unreadable",
      `the upstream's model listing is not in a shape this router recognizes (${dialectNote(dialect)})`,
    )
  }

  const entries = dedupe(parsed.data.data.map(toEntry))
  return parsed.data.has_more === true
    ? { ok: true, entries, truncated: true }
    : { ok: true, entries }
}

function fail(
  code: ListingFailureCode,
  message: string,
  status?: number,
  detail?: string,
): UpstreamListing {
  return {
    ok: false,
    code,
    message,
    ...(status === undefined ? {} : { status }),
    ...(detail === undefined || detail.length === 0 ? {} : { detail }),
  }
}

function dialectNote(dialect: Dialect): string {
  return `expected a "data" array of objects with an "id", as the ${dialect} listing returns`
}

function messageOf(error: unknown): string {
  if (isRouterError(error)) return error.message
  // The cause chain, not just the wrapper: "fetch failed" alone names nothing an operator can fix.
  const described = describeError(error, Number.POSITIVE_INFINITY)
  return described.length > 0 ? described : "the account's endpoint could not be resolved"
}
