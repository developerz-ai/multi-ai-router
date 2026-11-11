import { type DropSink, IGNORE_DROPS } from "./drops"
import { rejectField } from "./reject"

/**
 * The stateful half of openai-responses, refused (or, for encrypted reasoning, dropped) before any
 * upstream call on a non-Responses egress. The refusal rules of `reject.ts` apply: a field is named,
 * never a value from the body.
 */

const NO_STATE =
  "names conversation state held by the provider: this router stores nothing between requests and picks an account per request, so there is no stored response to continue from"

const NO_CONVERSATION =
  "names a conversation the provider stores and prepends to this request: this router holds none, and serving the turn anyway would answer with every turn it names missing"

const NO_PROMPT =
  "names a prompt template stored inside openai-responses, whose text this router never sees: it cannot be carried onto another dialect, and the turn without it is missing the instructions the caller wrote"

const NO_BACKGROUND =
  "`true` asks the provider to queue the turn and be polled for the result by id, which needs provider-side state this router does not hold and a retrieval endpoint it does not expose"

/**
 * `include` entries that are dropped rather than refused. `reasoning.encrypted_content` asks for the
 * account-bound reasoning handle a stateless client replays on its next turn; Codex sends it on
 * every request. Another dialect has no such handle, and the replayed one is dropped too
 * (`dropEncryptedReasoning`), so the pair is lossless to the caller and refusing it served nothing.
 */
const DROPPABLE_INCLUDES: ReadonlySet<string> = new Set(["reasoning.encrypted_content"])

const NO_ENCRYPTED_REASONING_OUTPUT =
  "asks for encrypted reasoning state, which the target dialect does not produce; dropped"

const NO_ENCRYPTED_REASONING_INPUT =
  "is encrypted reasoning state one provider account issued, which the target dialect cannot read; dropped, and the turn is served from the visible transcript"

/**
 * A `reasoning` input item's encrypted handle, dropped and reported by field path — never by value.
 *
 * The handle is opaque, bound to the account that minted it, and readable by nothing but that
 * provider. On another dialect it has no carrier at all; the visible transcript beside it is
 * the whole conversation the target can be shown.
 */
export function dropEncryptedReasoning(
  item: Readonly<Record<string, unknown>>,
  at: string,
  onDrop: DropSink,
): void {
  const value = item.encrypted_content
  if (value === null || value === undefined || value === "") return
  onDrop({ field: `${at}.encrypted_content`, reason: NO_ENCRYPTED_REASONING_INPUT })
}

/**
 * The stateful half of openai-responses, refused before any upstream call.
 *
 * `previous_response_id` and `store` are the dialect's whole reason for existing — a client sends
 * one turn and the *provider* remembers the rest. That contract cannot survive a hop onto an
 * account the router chose this request, on a dialect with no stored-conversation concept at all, so
 * the request is refused by name rather than served as though the missing history were empty
 * (docs/idea/06-protocol-translation.md#translation-matrix). `include` asks for extra fields on a
 * response shape the target does not produce, which fails the same way for the same reason — except
 * `reasoning.encrypted_content`, which is dropped and reported (see `DROPPABLE_INCLUDES`).
 *
 * `conversation`, `prompt`, and `background` are the same class under three later names.
 * `conversation` points at turns the provider would prepend and this router cannot read;
 * `prompt` points at instruction text stored provider-side that this router never sees; and
 * `background` asks the provider to queue the turn and hand back an id to poll, which is a stored
 * response by another route. Each is refused by name for the reason all statefulness is: served
 * anyway, the model answers a question the caller did not ask and nothing in the reply says so.
 *
 * `store: false` and `background: false` are the stateless cases and pass. An absent `store` is not
 * read as its provider-side default: the caller stated nothing, and refusing a request over a field
 * it never sent would make every ordinary client unservable.
 */
export function assertStatelessResponses(
  request: {
    readonly previous_response_id?: string | null | undefined
    readonly store?: boolean | null | undefined
    readonly include?: readonly string[] | null | undefined
    readonly conversation?: unknown
    readonly prompt?: unknown
    readonly background?: boolean | null | undefined
  },
  onDrop: DropSink = IGNORE_DROPS,
): void {
  if (typeof request.previous_response_id === "string") {
    rejectField("previous_response_id", NO_STATE)
  }
  if (request.store === true) rejectField("store", `\`true\` ${NO_STATE}`)
  const include = request.include ?? []
  if (include.some((entry) => !DROPPABLE_INCLUDES.has(entry))) {
    rejectField("include", "asks for openai-responses fields another dialect does not produce")
  }
  if (include.length > 0) onDrop({ field: "include", reason: NO_ENCRYPTED_REASONING_OUTPUT })
  if (request.conversation !== null && request.conversation !== undefined) {
    rejectField("conversation", NO_CONVERSATION)
  }
  if (request.prompt !== null && request.prompt !== undefined) rejectField("prompt", NO_PROMPT)
  if (request.background === true) rejectField("background", NO_BACKGROUND)
}

/**
 * An `item_reference` input item — the *transcript's* half of the same statefulness: it names a
 * stored item by id, and there is no content behind it this router could carry anywhere. (An
 * encrypted `reasoning` item is the other half, and is dropped instead: the visible transcript
 * beside it is complete without it — see {@link dropEncryptedReasoning}.)
 *
 * @throws TranslationError — always.
 */
export function rejectStatefulItem(field: string, kind: string): never {
  rejectField(field, `is a \`${kind}\` item, which ${NO_STATE}`)
}
