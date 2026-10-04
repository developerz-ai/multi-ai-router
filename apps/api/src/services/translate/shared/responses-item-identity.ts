import {
  type ResponsesRecoveryOptions,
  translationPendingLimit,
} from "./responses-snapshot-recovery"

/** Canonicalize compatible ID/index aliases before consumers or snapshot recovery see them. */
export function createResponsesItemIdentity(options: ResponsesRecoveryOptions = {}) {
  const limit = translationPendingLimit(options.maximumPendingBytes)
  const aliases = new Map<string, { key: string; id: string | null }>()
  let retained = 0
  let next = 0
  let unkeyedCall: string | undefined
  return (
    event: Record<string, unknown>,
  ): {
    event: Record<string, unknown>
    error?: string
    errorClass?: "translation_pending_overflow"
  } => {
    const type = event.type
    if (
      typeof type !== "string" ||
      !/^response\.(?:output_item\.(?:added|done)|(?:output_text|refusal|function_call_arguments)\.(?:delta|done))$/.test(
        type,
      )
    )
      return { event }
    const item =
      event.item !== null && typeof event.item === "object" && !Array.isArray(event.item)
        ? (event.item as Record<string, unknown>)
        : null
    const statedId = item?.id ?? event.item_id
    const id = typeof statedId === "string" ? `id:${statedId}` : null
    const index = typeof event.output_index === "number" ? `index:${event.output_index}` : null
    if (id === null && index === null && type !== "response.output_item.added") {
      if (unkeyedCall !== undefined && type.startsWith("response.function_call_arguments."))
        return { event: { ...event, item_id: unkeyedCall } }
      return { event }
    }
    const byId = id === null ? undefined : aliases.get(id)
    const byIndex = index === null ? undefined : aliases.get(index)
    if (byId !== undefined && byIndex !== undefined && byId !== byIndex)
      return { event, error: "Responses item identities disagree" }
    const identity = byId ?? byIndex ?? { key: `router-item-${next}`, id }
    if (id !== null && identity.id !== null && identity.id !== id)
      return { event, error: "Responses output index names two different items" }
    const missing = [id, index].filter(
      (alias): alias is string => alias !== null && !aliases.has(alias),
    )
    const charge =
      missing.reduce((sum, alias) => sum + Buffer.byteLength(alias, "utf8") + 128, 0) +
      (byId === undefined && byIndex === undefined ? 128 : 0)
    if (charge > limit - retained)
      return {
        event,
        error: "Translation identity state exceeds its configured limit",
        errorClass: "translation_pending_overflow",
      }
    retained += charge
    if (byId === undefined && byIndex === undefined) next += 1
    identity.id ??= id
    if (id === null && index === null && item?.type === "function_call") unkeyedCall = identity.key
    for (const alias of missing) aliases.set(alias, identity)
    return {
      event:
        item === null
          ? { ...event, item_id: identity.key }
          : {
              ...event,
              item: {
                ...item,
                id: identity.key,
                ...(item.type === "function_call"
                  ? { call_id: item.call_id ?? item.id ?? "" }
                  : {}),
              },
            },
    }
  }
}
