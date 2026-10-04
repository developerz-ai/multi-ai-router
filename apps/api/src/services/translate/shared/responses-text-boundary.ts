export function validResponsesTextIdentity(event: unknown, fallbackType?: string | null): boolean {
  if (event === null || typeof event !== "object") return true
  const type = "type" in event ? event.type : fallbackType
  if (
    typeof type !== "string" ||
    !/^response\.(?:output_text|refusal|function_call_arguments)\.(?:delta|done)$/.test(type)
  )
    return true
  const outputIndex = "output_index" in event ? event.output_index : undefined
  const contentIndex = "content_index" in event ? event.content_index : undefined
  const itemId = "item_id" in event ? event.item_id : undefined
  const index = (value: unknown) =>
    value == null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  return index(outputIndex) && index(contentIndex) && (itemId == null || typeof itemId === "string")
}

/** Constant-size state: only the last nonempty emitted text part is retained. */
export function createResponsesTextBoundary() {
  let previous: { item: string | number | null; part: number | string } | undefined
  return (event: {
    item_id?: unknown
    output_index?: unknown
    content_index?: unknown
    type?: unknown
    delta?: unknown
  }) => {
    const index = (value: unknown) =>
      value == null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    if (!index(event.output_index) || !index(event.content_index)) return null
    if (event.item_id != null && typeof event.item_id !== "string") return null
    if (typeof event.delta !== "string" || event.delta.length === 0) return null
    const item =
      typeof event.item_id === "string"
        ? event.item_id
        : typeof event.output_index === "number"
          ? event.output_index
          : null
    const part = typeof event.content_index === "number" ? event.content_index : String(event.type)
    const newItem = previous !== undefined && item !== previous.item
    const separator = previous !== undefined && (newItem || part !== previous.part)
    previous = { item, part }
    return { text: event.delta, newItem, separator }
  }
}
