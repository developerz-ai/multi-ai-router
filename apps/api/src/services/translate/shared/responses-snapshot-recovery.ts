import { createHash, type Hash } from "node:crypto"

export interface ResponsesRecoveryOptions {
  readonly maximumPendingBytes?: number | undefined
}

export function translationPendingLimit(value: number | undefined): number {
  const limit = value ?? 1_048_576
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > 33_554_432)
    throw new RangeError("maximumPendingBytes must be an integer from 1024 through 33554432")
  return limit
}

interface Evidence {
  readonly hash: Hash
  length: number
  final: boolean
}

/** Final snapshots can fill a missing suffix, never replace bytes already emitted. */
export function createResponsesSnapshotRecovery(options: ResponsesRecoveryOptions = {}) {
  const limit = translationPendingLimit(options.maximumPendingBytes)
  const evidence = new Map<string, Evidence>()
  let retained = 0
  const aliases = new Map<string, { key: string; id: string | null }>()
  return (
    event: Record<string, unknown>,
  ): {
    event: Record<string, unknown>
    error?: string
    errorClass?: "translation_pending_overflow"
  } => {
    const type = event.type
    if (typeof type !== "string") return { event }
    const kind = type.startsWith("response.output_text.")
      ? "text"
      : type.startsWith("response.refusal.")
        ? "refusal"
        : type.startsWith("response.function_call_arguments.")
          ? "arguments"
          : null
    if (kind === null || (!type.endsWith(".delta") && !type.endsWith(".done"))) return { event }
    if (type.endsWith(".done") && event.item_id == null && event.output_index == null)
      return { event: { ...event, type: type.replace(/\.done$/, ".delta"), delta: "" } }
    const id = typeof event.item_id === "string" ? `id:${event.item_id}` : null
    const index = typeof event.output_index === "number" ? `index:${event.output_index}` : null
    const byId = id === null ? undefined : aliases.get(id)
    const byIndex = index === null ? undefined : aliases.get(index)
    if (byId !== undefined && byIndex !== undefined && byId !== byIndex)
      return { event, error: "Responses item identities disagree" }
    const identity = byId ?? byIndex ?? { key: id ?? index ?? "unkeyed", id }
    if (id !== null && identity.id !== null && id !== identity.id)
      return { event, error: "Responses output index names two different items" }
    identity.id ??= id
    const item = identity.key
    for (const alias of [id, index]) {
      if (alias === null || aliases.has(alias)) continue
      retained += Buffer.byteLength(alias, "utf8") + 128
      if (retained > limit)
        return {
          event,
          error: "Translation recovery state exceeds its configured limit",
          errorClass: "translation_pending_overflow",
        }
      aliases.set(alias, identity)
    }
    const key = JSON.stringify([item, event.content_index ?? null, kind])
    let state = evidence.get(key)
    if (state === undefined) {
      // Bound the number and size of identities; emitted payload text itself is never retained.
      retained += Buffer.byteLength(key, "utf8") + 256
      if (retained > limit)
        return {
          event,
          error: "Translation recovery state exceeds its configured limit",
          errorClass: "translation_pending_overflow",
        }
      state = { hash: createHash("sha256"), length: 0, final: false }
      evidence.set(key, state)
    }
    const done = type.endsWith(".done")
    const value = event[done ? kind : "delta"]
    if (typeof value !== "string") return { event: { ...event, delta: "" } }
    let delta = value
    if (done) {
      // UTF-16 code units preserve lone surrogates and split surrogate pairs exactly. Hash only
      // new fragments and this final prefix, avoiding repeated accumulated-prefix hashing.
      const prefix = createHash("sha256")
        .update(Buffer.from(value.slice(0, state.length), "utf16le"))
        .digest()
      if (value.length < state.length || !prefix.equals(state.hash.copy().digest()))
        return { event, error: "Final Responses snapshot disagrees with emitted content" }
      if (state.final && value.length !== state.length)
        return { event, error: "Responses final snapshot changed after finalization" }
      delta = value.slice(state.length)
    } else if (state.final && delta.length > 0) {
      return { event, error: "Responses delta arrived after its final snapshot" }
    }
    state.hash.update(Buffer.from(delta, "utf16le"))
    state.length += delta.length
    state.final ||= done
    return { event: { ...event, type: type.replace(/\.done$/, ".delta"), delta } }
  }
}
