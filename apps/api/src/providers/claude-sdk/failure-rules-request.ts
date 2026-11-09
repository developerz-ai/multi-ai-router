import { any, pattern, phrase, type SdkRule } from "./failure-rules-vocabulary"

/**
 * The first six rows of the Agent-SDK failure classification table
 * (docs/idea/11-anthropic-agent-sdk.md §9), most specific first: the failures that are about the
 * *request* — the client's own shape, a session the CLI no longer holds, or a router image too old
 * for the model asked for. They are the head of the table because they are the most specific
 * sentences the CLI has, and because a `400` for them is a fact about the request rather than
 * about the account.
 *
 * Order inside this array is load-bearing, and so is the order this array holds within the composed
 * table: these rows come before every quota and account row.
 */
/**
 * Thrown by both Claude transports when a forced tool call never came (`claude-sdk/invoker.ts`,
 * `claude-fast/response.ts`). Its tail is the phrase the `forced-tool-unmet` row matches.
 */
export const FORCED_TOOL_UNMET =
  "tool_choice forced a tool call, but the turn completed without one"

export const SDK_REQUEST_FAILURE_RULES: readonly SdkRule[] = [
  {
    // The rules that are **not** CLI prose: every sentence here is one of this router's own throws
    // (`request.ts`, `tools/register.ts`, `invoker.ts`). Provenance is our source rather than the
    // binary's; a reworded throw site degrades to `unknown`. `invalid-request`, because all three
    // are client request-shape bugs Anthropic's own API answers `400`: no failover, no breaker
    // strike — `failoverKind` maps the kind to `client-error`, which `breaker.ts` exempts.
    kind: "invalid-request",
    signal: "claude-sdk:tool-choice-unsatisfiable",
    status: 400,
    clientMessage:
      "the request's tool_choice demands a tool call its own declared tools do not provide",
    match: phrase(
      "which is not among the declared tools",
      "which requires a tool call, but the request declared no tools",
      "is recognized but its payload is one this router cannot read",
    ),
  },
  {
    // The turn *ran* and answered free-form text where a tool call was forced: an upstream that
    // did not comply — `server-error`, retryable because the next account's model may honour it.
    kind: "server-error",
    signal: "claude-sdk:forced-tool-unmet",
    status: 502,
    clientMessage: "the turn ended without the tool call the request's tool_choice forced",
    match: phrase("but the turn completed without one"),
  },
  {
    // Both the session and the rewind point: a fork whose `resumeSessionAt` uuid the transcript
    // no longer holds ("No message found with message.uuid of:", CLI 2.1.261) fails identically
    // on every retry, so it is the same class as a vanished session — evict the binding, replay
    // once in place. Before it was named here it fell to `unknown`, which is not retryable: the
    // request failed outright and the binding that caused it survived to fail the next one.
    kind: "stale-session",
    signal: "claude-sdk:session-not-found",
    status: 502,
    clientMessage: "the Claude Agent SDK session this conversation resumed no longer exists",
    match: phrase("no conversation found with session id", "no message found with message.uuid"),
  },
  {
    // Two wordings for one refusal, and the second is why this row is worth a comment. 0.3.x said
    // "is currently running as a background agent"; 2.1.x says "Session <id> is running as a
    // background session. Run `claude agents` to find its id, then `claude attach <id>`" — and it
    // says it on **stderr**, behind an `exit 1`. When only the older phrase was listed the newer
    // one fell past this row to `claude-sdk:subprocess-exit`: a `502`, no in-place fork, and a
    // failover that restarted the conversation on a cold account (production, 2026-09-06). A
    // reworded refusal must never silently become a crash, which is what ordering this rule ahead
    // of `subprocess-exit` is for.
    //
    // It should now be rare rather than routine: `session/inflight.ts` detaches a *concurrent*
    // turn on one conversation before it can ask the CLI to resume a session it is already
    // running. This row is what catches the collisions that detachment cannot see — another
    // replica's turn, or a session the CLI still holds after ours ended.
    kind: "busy-session",
    signal: "claude-sdk:session-busy",
    status: 503,
    clientMessage: "the Claude Agent SDK session this conversation resumed is still running",
    // 2.1.289 reworded it a third time, again on stderr behind `exit 1`: `${subject} is running
    // in the background${job}. … Add --fork-session to branch off a copy instead.`, where the
    // subject is the session's quoted **title** when it has one and "That session" only when it
    // has none. Matching "session is running in the background" caught the untitled form alone;
    // Claude Code's sessions are titled, so prod 2026-10-07 kept answering 502 on resumes that
    // arrived while the previous turn's process was still exiting. Match the predicate, never
    // the subject.
    match: phrase(
      "is currently running as a background agent",
      "is running as a background session",
      "is running in the background",
    ),
  },
  {
    // Waiting does not fix an oversized prompt: an identical retry burns a whole upstream turn on
    // every account in the pool to fail identically, striking each breaker on the way. `400` says
    // the request itself is the problem. Wordings: the CLI's own "Prompt is too long" (2.1.261
    // string table), the API's fuller "prompt is too long: N tokens > M maximum", its
    // `max_tokens` phrasing, the OpenAI-compatible code — and, when the SDK states it outright,
    // its `terminal_reason: "prompt_too_long"`.
    kind: "invalid-request",
    signal: "claude-sdk:prompt-too-long",
    status: 400,
    clientMessage:
      "the prompt exceeds the model's context window; an identical retry fails the same way",
    match: any(
      phrase("prompt is too long", "context_length_exceeded", "exceed context limit"),
      (text) => text.terminalReason === "prompt_too_long",
    ),
  },
  {
    // The router's own `claude` is older than the model asked for — the API answers `400 Claude
    // Code 2.1.198 does not support this model; version 2.1.251 or newer is required` (Meridian,
    // observed live). Every account behind this router shares that binary, so a failover would
    // spend the whole pool and trip every breaker on a fact about the image. `400` to the client,
    // no account struck; the fix is a router upgrade and the sentence says so.
    kind: "invalid-request",
    signal: "claude-sdk:cli-too-old-for-model",
    status: 400,
    clientMessage:
      "this router's claude CLI is older than the requested model requires — the router image needs upgrading, not the request",
    match: pattern(/claude code(?: \d[\w.+-]*)? does not support this model/),
  },
]
