import { TranslationError } from "@multi-ai-router/core"
import type { z } from "zod"

/**
 * Every refusal a request translator can make, in one place.
 *
 * "Fail loud, never degrade" (docs/idea/06-protocol-translation.md#design-rules): a request whose
 * *contract* cannot be carried into the target dialect returns a `400` naming the offending field,
 * before any upstream call. Silently dropping a contract field is a bug; dropping a documented
 * *hint* is not, and the lossy-edge table is the authority on which is which.
 *
 * No message here ever interpolates a value out of the body — a rejected request may carry
 * anything, and an error body is one of the surfaces credential material must never reach
 * (docs/idea/07-security.md). Field names, tool names, and block type names are structural and are
 * the only thing quoted back.
 */

/** @throws TranslationError — always. `never` so callers narrow on the call. */
export function rejectField(field: string, reason: string): never {
  throw new TranslationError(`\`${field}\` ${reason}`)
}

/**
 * Parse a body into the dialect's shape, or refuse with the path that failed.
 *
 * The one place a translated request body is materialized. `06-protocol-translation.md` allows it
 * exactly here: a cross-dialect conversion has to rebuild the body field by field, so the parse is
 * genuinely required rather than speculative.
 *
 * @throws TranslationError when the body does not match `schema`.
 */
export function parseRequest<S extends z.ZodType>(
  schema: S,
  body: unknown,
  dialect: string,
): z.infer<S> {
  const parsed = schema.safeParse(body)
  if (parsed.success) return parsed.data

  const located = locate(parsed.error.issues, [])
  if (located === undefined) throw new TranslationError(`not a valid ${dialect} request`)
  const path = located.path.length === 0 ? "body" : located.path.join(".")
  throw new TranslationError(`not a valid ${dialect} request: \`${path}\` — ${located.message}`)
}

type Issue = z.ZodError["issues"][number]

interface Located {
  readonly path: readonly PropertyKey[]
  readonly message: string
}

/**
 * The deepest field a failure points at.
 *
 * A union reports at its **own** path — `messages.0.content` — while the answer a caller can act on
 * is inside one of its branches, `messages.0.content.0`. Naming the offending field is the entire
 * contract of a translation `400`, so every branch is walked and the longest path wins.
 */
function locate(issues: readonly Issue[], prefix: readonly PropertyKey[]): Located | undefined {
  let best: Located | undefined
  for (const issue of issues) {
    const path = [...prefix, ...issue.path]
    best = deeper(best, { path, message: issue.message })
    if (issue.code !== "invalid_union") continue
    for (const branch of issue.errors) best = deeper(best, locate(branch, path))
  }
  return best
}

function deeper(current: Located | undefined, candidate: Located | undefined): Located | undefined {
  if (candidate === undefined) return current
  if (current === undefined) return candidate
  return candidate.path.length > current.path.length ? candidate : current
}

const NO_COUNTERPART = "has no anthropic counterpart; it is refused rather than silently ignored"

/**
 * The three OpenAI fields that cannot reach Anthropic at all.
 *
 * They are refused rather than dropped because each is a *contract*: a caller that asked for
 * `logprobs` and got a body without them was answered a different question than the one it asked.
 * `n > 1` is the same in a louder way — a caller expecting four completions cannot use one.
 * `n: 1` is the default and passes, since asking for one completion is what Anthropic already does.
 */
export function assertTranslatableToAnthropic(request: {
  readonly n?: number | null | undefined
  readonly logprobs?: boolean | null | undefined
  readonly top_logprobs?: number | null | undefined
}): void {
  if (request.logprobs === true) rejectField("logprobs", NO_COUNTERPART)
  if (typeof request.top_logprobs === "number") rejectField("top_logprobs", NO_COUNTERPART)
  if (typeof request.n === "number" && request.n > 1) {
    rejectField("n", "> 1 has no anthropic counterpart: one request yields exactly one completion")
  }
}
