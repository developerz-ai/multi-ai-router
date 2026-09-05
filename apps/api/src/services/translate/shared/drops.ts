/**
 * How a request translator says what it left out.
 *
 * A cross-dialect hop is lossy by nature, and the lossy-edge table in
 * `docs/idea/06-protocol-translation.md` splits every loss into two kinds. A *hint* — `top_k`,
 * `cache_control`, a thinking block — is dropped silently, because every request carries some and a
 * line per request says nothing. A *drop the caller would want to know about* — a server-side tool
 * the target cannot run, a document the target cannot read, a block type this build has never seen
 * — is reported through the sink here, by field path and structural reason, and the caller (which
 * holds the request id and the logger) writes the line. Reporting instead of refusing is the point:
 * a coding agent sends the whole toolkit its own provider knows, and a `400` over one tool it never
 * asked this upstream to run served nothing.
 *
 * The sink keeps the translator pure the way an injected clock does: the same body with the same
 * sink produces the same drops in the same order, and a translator never logs on its own.
 *
 * Nothing reported here quotes a value out of the body. Field paths, tool names, block type names
 * and media types are structural, and are the only things a reason names
 * (`shared/reject.ts` states the same rule for refusals).
 */

export interface TranslationDrop {
  /** The path of what was dropped, in the client's own dialect — `tools[2]`, `messages[4].content[1]`. */
  readonly field: string
  /** Why the target could not carry it. Structural; never a value from the body. */
  readonly reason: string
}

export type DropSink = (drop: TranslationDrop) => void

/** The sink a translator uses when its caller passed none — a unit test asserting the body alone. */
export const IGNORE_DROPS: DropSink = () => undefined
