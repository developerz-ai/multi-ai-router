/**
 * The I/O half of the Claude subscription transport: one `query()` call, one answer.
 *
 * This is the SDK path's `FetchLike`. It exists as a type before it exists as an implementation for
 * the same reason `fetch` is injected on the HTTP path — the data plane must be dispatchable without
 * a subprocess, and `bin/test` may never spawn a real `claude` CLI
 * (docs/idea/11-anthropic-agent-sdk.md §9, CLAUDE.md testing rules).
 *
 * The contract is deliberately narrow, and the narrowness is what keeps the rest of the data plane
 * from knowing an SDK exists:
 *
 * - **In:** an Anthropic Messages request body. The client's own dialect was already converted, by
 *   the same translator an `anthropic-api` account would have used.
 * - **Out:** a `Response` whose body is Anthropic Messages — re-synthesized, never relayed
 *   (§6: even `POST /v1/messages` against a subscription is a re-synthesis). Downstream, that is
 *   indistinguishable from an upstream's own answer, so the relay, the token observer, and the
 *   `UsageRecord` are written once for both transports.
 * - **Abort:** one signal, already composed from the client's disconnect and the attempt deadline.
 *   Aborting terminates the subprocess; a client that goes away must never orphan one (§9).
 */
export interface SdkInvocation {
  /** Which Account this runs as. Rate-limit state and session lineage are keyed by it, never global. */
  readonly accountId: string
  /** The isolated `CLAUDE_CONFIG_DIR`. Already resolved, never empty. */
  readonly configDir: string
  /** The model after the Account's alias map. Passed through, never substituted. */
  readonly model: string
  /** Anthropic Messages request bytes. Null only when the client sent no body at all. */
  readonly body: Uint8Array | null
  readonly signal: AbortSignal
}

export type SdkInvoker = (invocation: SdkInvocation) => Promise<Response>
