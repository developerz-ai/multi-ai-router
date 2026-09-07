import { z } from "zod"
import { createCliProbe } from "./cli-probe"
import type { SdkConcurrency } from "./concurrency"
import type { CredentialFreshness } from "./credential-freshness"
import { classifySdkFailure, readSdkFailure } from "./errors"
import {
  IdleQueryColdCredentialError,
  type IdleQueryFn,
  type IdleQueryHandle,
  IdleQueryTimeoutError,
  openIdleQuery,
  rejectOnAbort,
} from "./idle-query"
import { type CliResolution, resolveClaudeCli } from "./resolve-cli"

/**
 * What one Claude subscription can be asked for, straight from the Agent SDK — the only sanctioned
 * live voice a subscription has. There is no HTTP listing to GET (non-negotiable 1 forbids the
 * token that would be needed) and no discover button, so until this existed a pool of
 * subscriptions answered `GET /v1/models` with `data: []`.
 *
 * **It spends no turn.** `Query.supportedModels()` is answered from the CLI's `initialize`
 * handshake (`(await this.initialization).models` in the SDK), which the subprocess completes
 * before it reads any prompt. `openIdleQuery` (`idle-query.ts`) brings the subprocess up under the
 * full sandbox and holds it there on a prompt that never yields; the list is read and the process
 * ended. No message ever reaches a model and nothing is billed. If the SDK ever required a turn to
 * answer this, the live source would be dropped in favour of the shipped table — never the other
 * way round.
 *
 * Never throws across the seam. `null` is "unavailable" — no binary, the ceiling, a timeout, an
 * unreadable answer — and the caller falls back to the shipped table. An auth failure is reported
 * distinctly so the caller can tell a dead credential from a slow one, and so is a **cold** one: a
 * credential inside the CLI's refresh window is not listed at all, because the subprocess that
 * would list it would be ended before the rotated refresh token was written (`idle-query.ts`).
 */

export interface SdkModelInfo {
  /** The id a client sends: a concrete model or a family alias (`sonnet`). */
  readonly id: string
  /** What an alias resolves to today, when the SDK stated it. Null for a concrete id. */
  readonly resolvedModel: string | null
  readonly displayName: string | null
}

export type SdkModelListing =
  | { readonly kind: "listed"; readonly models: readonly SdkModelInfo[] }
  /** The credential needs a human. Distinct from `null`, which a retry may recover. */
  | { readonly kind: "auth" }
  /** The credential is about to be refreshed and only a real turn may do that. Nothing was spawned. */
  | { readonly kind: "cold" }

/** Why the answer was `null`. For the caller's log line only. */
export type SdkModelListUnavailable =
  | "no_cli"
  | "at_ceiling"
  | "timeout"
  | "failed"
  | "malformed"
  | "empty"

export interface SdkModelListInput {
  readonly accountId: string
  /** The isolated `CLAUDE_CONFIG_DIR`. Also the subprocess's working directory. */
  readonly configDir: string
  /** Bounds the whole thing — the wait for a slot, the spawn, and the handshake. Config, never a constant. */
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface SdkModelListerOptions {
  /** `CLAUDE_CLI_PATH`, validated at the env boundary. Re-resolved per call — see `resolve-cli.ts`. */
  readonly cliPathOverride: string | null
  /** The **same instance** the dispatch path holds — one memory budget, one gate. */
  readonly concurrency: SdkConcurrency
  /** Passed straight to `openIdleQuery`: this probe spawns, so it crosses the refresh window too. */
  readonly freshness?: CredentialFreshness
  /** Injected in tests. Defaults to the real ladder over this host's filesystem. */
  readonly resolveCli?: () => CliResolution
  /** Injected in tests, for the reason `SdkInvokerDeps.runQuery` is: no test may spawn a `claude`. */
  readonly runQuery?: IdleQueryFn
  /** Told why an answer was `null`, with the upstream's own words (safe for the log redactor only). */
  readonly onUnavailable?: (reason: SdkModelListUnavailable, detail: string) => void
}

export interface SdkModelLister {
  list(input: SdkModelListInput): Promise<SdkModelListing | null>
}

/**
 * Tolerant on purpose: the SDK adding a field must never fail the listing, and one malformed entry
 * costs that entry, not the whole answer.
 */
const modelInfoSchema = z.looseObject({
  value: z.unknown().optional(),
  resolvedModel: z.unknown().optional(),
  displayName: z.unknown().optional(),
})
const listSchema = z.array(modelInfoSchema)

export function createSdkModelLister(options: SdkModelListerOptions): SdkModelLister {
  const resolveCli =
    options.resolveCli ??
    (() => resolveClaudeCli(createCliProbe({ override: options.cliPathOverride })))
  const unavailable = (reason: SdkModelListUnavailable, detail = ""): null => {
    options.onUnavailable?.(reason, detail)
    return null
  }

  return {
    async list(input) {
      // Resolved before a slot is taken: a router with no binary answers immediately rather than
      // occupying capacity a live request could have used in order to discover it cannot spawn.
      const resolution = resolveCli()
      if (!resolution.ok) return unavailable("no_cli")

      let handle: IdleQueryHandle
      try {
        handle = await openIdleQuery({
          accountId: input.accountId,
          configDir: input.configDir,
          cliPath: resolution.path,
          concurrency: options.concurrency,
          ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
          timeoutMs: input.timeoutMs,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(options.runQuery === undefined ? {} : { runQuery: options.runQuery }),
        })
      } catch (error) {
        if (error instanceof IdleQueryColdCredentialError) return { kind: "cold" }
        if (error instanceof IdleQueryTimeoutError) {
          return unavailable(error.phase === "queued" ? "at_ceiling" : "timeout")
        }
        return failure(error, unavailable)
      }

      try {
        if (handle.query.supportedModels === undefined) {
          return unavailable("malformed", "the SDK's query object has no supportedModels()")
        }
        const answer = await Promise.race([
          handle.query.supportedModels(),
          rejectOnAbort(handle.signal),
        ])
        return readListing(answer, unavailable)
      } catch (error) {
        if (handle.timedOut()) return unavailable("timeout")
        return failure(error, unavailable)
      } finally {
        await handle.close()
      }
    },
  }
}

/** An auth failure is its own answer; everything else is unavailable, with the SDK's words for the log. */
function failure(
  error: unknown,
  unavailable: (reason: SdkModelListUnavailable, detail?: string) => null,
): SdkModelListing | null {
  if (classifySdkFailure(error).classification.kind === "auth") return { kind: "auth" }
  return unavailable("failed", readSdkFailure(error).message)
}

function readListing(
  answer: unknown,
  unavailable: (reason: SdkModelListUnavailable, detail?: string) => null,
): SdkModelListing | null {
  const parsed = listSchema.safeParse(answer)
  if (!parsed.success) return unavailable("malformed", "supportedModels() was not an array")

  const byId = new Map<string, SdkModelInfo>()
  for (const entry of parsed.data) {
    const id = nonEmpty(entry.value)
    // The first entry for an id wins: a list that names a model twice has already said what it means.
    if (id === null || byId.has(id)) continue
    byId.set(id, {
      id,
      resolvedModel: nonEmpty(entry.resolvedModel),
      displayName: nonEmpty(entry.displayName),
    })
  }
  // A subscription that can be asked for nothing is not a subscription; read it as an answer this
  // build cannot use, so the shipped table stands in rather than an empty catalog.
  if (byId.size === 0) return unavailable("empty")
  return { kind: "listed", models: [...byId.values()] }
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}
