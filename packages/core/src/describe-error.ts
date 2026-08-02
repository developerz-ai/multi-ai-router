/**
 * One description for an error and everything it wraps.
 *
 * The wrapper-only alternative — `error.message` and nothing else — is how a drizzle failure
 * spends its whole budget on "Failed query: <500 chars of statement text>" while the driver's
 * actual complaint sits one `cause` down, discarded. This helper walks the `cause` chain and
 * joins it **innermost first**, so truncation eats the wrapper's statement text and never the
 * root complaint.
 *
 * Redaction is deliberately not done here: core knows nothing about what a deployment considers
 * secret. Callers that persist or log the result scrub it first (`apps/api/src/logging/redact.ts`
 * on the server; `scrubCredentials` from this package on the boot path).
 */

/**
 * How many chained messages one description may join. When a chain is deeper, the *outermost*
 * wrappers are dropped — the innermost message is the complaint and is never lost to this cap.
 */
const MAX_CHAIN_MESSAGES = 5

/** Hard bound on the walk itself, so a cyclic `cause` chain terminates. */
const MAX_CHAIN_HOPS = 32

/**
 * Sub-errors quoted out of one `AggregateError`. Bun's multi-address connect refusal — exactly a
 * Postgres outage — throws two or three; quoting five covers that with room without letting a
 * pathological aggregate become the whole line.
 */
const MAX_AGGREGATE_PARTS = 5

/**
 * Describes `error` and its `cause` chain in at most `maxChars` characters, innermost message
 * first, joined with `" ← "`. Handles `AggregateError` (whose `message` defaults to `""` and
 * whose payload lives in `.errors`) and non-`Error` throwables. Pass `Number.POSITIVE_INFINITY`
 * when the caller bounds the result itself — e.g. because it redacts before truncating.
 */
export function describeError(error: unknown, maxChars: number): string {
  // Outermost wrappers go first when the chain outgrows the cap: the innermost message is the
  // one an operator cannot reconstruct from context.
  const chain = collectChain(error).slice(-MAX_CHAIN_MESSAGES)
  chain.reverse()
  const joined = chain.join(" ← ")
  if (joined.length <= maxChars) return joined
  return `${joined.slice(0, Math.max(0, maxChars - 1))}…`
}

/** The chain's messages, outermost → innermost, deduplicated, cycle-guarded. */
function collectChain(error: unknown): string[] {
  const messages: string[] = []
  const seen = new Set<Error>()
  let current: unknown = error

  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop += 1) {
    if (!(current instanceof Error)) {
      // A non-Error `cause` (or a non-Error throw) ends the chain: it has no `cause` of its own.
      push(messages, String(current))
      break
    }
    if (seen.has(current)) break
    seen.add(current)
    push(messages, messageOf(current))
    if (current.cause === undefined || current.cause === null) break
    current = current.cause
  }
  return messages
}

function push(messages: string[], message: string): void {
  // A wrapper that re-states its cause verbatim adds length, not information.
  if (message !== "" && !messages.includes(message)) messages.push(message)
}

function messageOf(error: Error): string {
  if (error instanceof AggregateError) return aggregateMessage(error)
  if (error.message === "") return error.name
  // `Error` the name says nothing; a subclass's name ("PostgresError") is worth the prefix.
  return error.name === "Error" ? error.message : `${error.name}: ${error.message}`
}

/**
 * `AggregateError.message` defaults to `""`, so reading it the way a plain `Error` is read
 * renders the whole failure as "AggregateError" — which is what a multi-address connect
 * refusal looks like without this case. The payload is `.errors`.
 */
function aggregateMessage(error: AggregateError): string {
  const parts: string[] = []
  for (const sub of error.errors.slice(0, MAX_AGGREGATE_PARTS)) {
    push(parts, sub instanceof Error ? messageOf(sub) : String(sub))
  }
  const overflow = error.errors.length - MAX_AGGREGATE_PARTS
  if (overflow > 0) parts.push(`+${overflow} more`)
  const body = parts.join("; ")
  if (body === "") return error.message === "" ? error.name : error.message
  return error.message === "" ? body : `${error.message}: ${body}`
}
