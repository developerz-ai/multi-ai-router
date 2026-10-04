import type { SseEvent } from "../sse/emit"
import type { OpenAiFinishReason } from "./stop-reason"
export interface ToolCallDelta {
  readonly index: number
  readonly id?: string | undefined
  readonly type?: "function" | undefined
  readonly function: { readonly name?: string | undefined; readonly arguments?: string | undefined }
}

export interface ChunkDelta {
  readonly role?: "assistant"
  readonly content?: string
  readonly tool_calls?: readonly ToolCallDelta[]
}

export function chatStreamChunk(
  identity: { readonly id: string; readonly model: string; readonly created: number },
  delta: ChunkDelta,
  finishReason: OpenAiFinishReason | null,
): SseEvent {
  return {
    data: JSON.stringify({
      ...identity,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }),
  }
}
