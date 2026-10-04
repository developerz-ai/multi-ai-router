/** Expand only final item snapshots; ordinary delta payloads take the unchanged single-event path. */
export function responsesFinalEvents(payload: unknown): readonly unknown[] {
  if (payload === null || typeof payload !== "object") return [payload]
  const event = payload as Record<string, unknown>
  if (event.type !== "response.output_item.done" && event.type !== "response.output_item.added")
    return [payload]
  const item = event.item
  if (item === null || typeof item !== "object") return [payload]
  const value = item as Record<string, unknown>
  // A final mirror without either item identity cannot be attached to an earlier live item.
  // In particular, synthesizing an added event here would invent a second unkeyed tool call.
  if (event.type === "response.output_item.done" && value.id == null && event.output_index == null)
    return []
  const identity = { item_id: value.id, output_index: event.output_index }
  if (value.type === "function_call") {
    const added = { ...event, type: "response.output_item.added" }
    if (
      typeof value.arguments !== "string" ||
      (event.type === "response.output_item.added" && value.arguments.length === 0)
    )
      return event.type === "response.output_item.done" ? [added, payload] : [added]
    return [
      added,
      {
        ...identity,
        type:
          event.type === "response.output_item.done"
            ? "response.function_call_arguments.done"
            : "response.function_call_arguments.delta",
        ...(event.type === "response.output_item.done"
          ? { arguments: value.arguments }
          : { delta: value.arguments }),
      },
      ...(event.type === "response.output_item.done" ? [payload] : []),
    ]
  }
  if (
    event.type !== "response.output_item.done" ||
    value.type !== "message" ||
    !Array.isArray(value.content)
  )
    return [payload]
  return value.content.flatMap<unknown>((part: unknown, content_index: number) => {
    if (part === null || typeof part !== "object") return []
    const value = part as Record<string, unknown>
    if (value.type === "output_text" && typeof value.text === "string")
      return [{ ...identity, content_index, type: "response.output_text.done", text: value.text }]
    if (value.type === "refusal" && typeof value.refusal === "string")
      return [{ ...identity, content_index, type: "response.refusal.done", refusal: value.refusal }]
    return []
  })
}
