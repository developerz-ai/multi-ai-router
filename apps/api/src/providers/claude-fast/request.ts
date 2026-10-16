import { InvalidRequestError } from "@multi-ai-router/core"
import { z } from "zod"
import { scrubSystemPrompt } from "../claude-sdk/scrub"
import type { FastCredential } from "./credential"
import { CLAUDE_FAST_CLI_VERSION, stableUuid, stampIntegrity, versionSuffix } from "./integrity"
import { HUMAN_IDENTITY, SDK_IDENTITY } from "./profile"

const block = z.looseObject({ type: z.string() })
const request = z.looseObject({
  model: z.string().optional(),
  max_tokens: z.number().int().positive(),
  system: z.union([z.string(), z.array(block)]).nullish(),
  messages: z
    .array(
      z.looseObject({
        role: z.enum(["user", "assistant", "system"]),
        content: z.union([z.string(), z.array(block)]),
      }),
    )
    .min(1),
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
  stream: z.boolean().nullish(),
})
export type FastRequest = z.infer<typeof request>
export function readFastRequest(bytes: Uint8Array | null): FastRequest {
  try {
    const result = request.safeParse(
      JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())),
    )
    if (result.success) return result.data
  } catch {
    /* No parser error may retain request content. */
  }
  throw new InvalidRequestError("invalid Claude Messages request for fast mode")
}

/** Native histories/tool names/signatures/cache controls survive; no host context or tools are added. */
export function prepareFastRequest(input: {
  request: FastRequest
  model: string
  identity: FastCredential
  accountId: string
  apiKeyId: string
  sessionKey: string
}) {
  const { request: original } = input
  const system =
    typeof original.system === "string"
      ? [{ type: "text", text: original.system }]
      : (original.system ?? []).map((entry) => ({ ...entry }))
  const nativeBilling = system.find(
    (entry) =>
      typeof entry.text === "string" && entry.text.startsWith("x-anthropic-billing-header:"),
  )
  const nativeText = typeof nativeBilling?.text === "string" ? nativeBilling.text : null
  const nativeVersion = nativeText && /\bcc_version=(\d+\.\d+\.\d+)\./.exec(nativeText)?.[1]
  if (nativeVersion && nativeVersion !== CLAUDE_FAST_CLI_VERSION) return null
  const clientSystem = system
    .filter(
      (entry) =>
        entry !== nativeBilling && entry.text !== HUMAN_IDENTITY && entry.text !== SDK_IDENTITY,
    )
    .flatMap((entry) => {
      if (entry.type !== "text" || typeof entry.text !== "string") return [entry]
      const text = nativeText ? entry.text : scrubSystemPrompt(entry.text)
      return typeof text === "string" ? [{ ...entry, text }] : []
    })
  const firstUser = original.messages.find((message) => message.role === "user")
  const firstText = textOf(firstUser?.content)
  const namespace = `${input.accountId}\0${input.apiKeyId}\0${input.sessionKey}`
  const sessionId = stableUuid(namespace)
  let lastHuman = 0
  let prompts = 0
  for (const [index, message] of original.messages.entries()) {
    if (
      message.role === "user" &&
      (typeof message.content === "string" ||
        !message.content.some((entry) => entry.type === "tool_result"))
    ) {
      lastHuman = index
      prompts++
    }
  }
  const promptId =
    (nativeText && /\bcc_prompt_id=([0-9a-f-]{36});/i.exec(nativeText)?.[1]) ||
    stableUuid(`${namespace}\0${JSON.stringify(original.messages.slice(0, lastHuman + 1))}`)
  const incomingOrigin = nativeText && /\bcc_turn_origin=([a-z_]{1,32});/.exec(nativeText)?.[1]
  const subagent = nativeText?.includes("cc_is_subagent=true;") === true
  // Native helpers deliberately omit origin; generic calls have no private CLI attribution to retain.
  const origin = incomingOrigin
    ? incomingOrigin === "sdk"
      ? "human"
      : incomingOrigin
    : nativeText?.includes("cch=") || subagent
      ? null
      : "human"
  const suffix =
    (nativeText && /\bcc_version=\d+\.\d+\.\d+\.([0-9a-f]{3});/i.exec(nativeText)?.[1]) ||
    versionSuffix(firstText, CLAUDE_FAST_CLI_VERSION)
  const promptIndex =
    (nativeText && /\bcc_prompt_index=(\d+);/.exec(nativeText)?.[1]) || String(prompts)
  const turnIndex =
    (nativeText && /\bcc_turn_index=(\d+);/.exec(nativeText)?.[1]) ||
    String(original.messages.filter((message) => message.role === "assistant").length + 1)
  const previous = nativeText && /\bcc_prev_req=(req_[A-Za-z0-9_-]{1,36});/.exec(nativeText)?.[1]
  const billing =
    `x-anthropic-billing-header: cc_version=${CLAUDE_FAST_CLI_VERSION}.${suffix}; cc_entrypoint=cli; cch=00000;` +
    (subagent ? " cc_is_subagent=true;" : "") +
    (previous ? ` cc_prev_req=${previous};` : "") +
    (origin || subagent ? ` cc_prompt_id=${promptId};` : "") +
    (origin
      ? ` cc_turn_origin=${origin}; cc_prompt_index=${promptIndex}; cc_turn_index=${turnIndex};`
      : "")
  const messages = original.messages.map((message) => ({
    ...message,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((entry) => ({ ...entry })),
  }))
  const tools = original.tools?.map((tool) => ({ ...tool })) ?? []
  const identityBlock = system.find(
    (entry) => entry.text === HUMAN_IDENTITY || entry.text === SDK_IDENTITY,
  )
  const outputSystem: Record<string, unknown>[] = [
    { type: "text", text: billing },
    { ...(identityBlock ?? { type: "text" }), text: subagent ? SDK_IDENTITY : HUMAN_IDENTITY },
    ...clientSystem,
  ]
  const body: Record<string, unknown> = {
    model: input.model,
    messages,
    system: outputSystem,
    tools,
    metadata: {
      user_id: JSON.stringify({
        device_id: input.identity.deviceId,
        account_uuid: input.identity.accountUuid,
        session_id: sessionId,
      }),
    },
    max_tokens: original.max_tokens,
  }
  // Keep new protocol fields and per-turn instructions instead of flattening them into prose.
  for (const [key, value] of Object.entries(original))
    if (!Object.hasOwn(body, key) && key !== "stream") body[key] = value
  if (
    body.cache_control === undefined &&
    !hasCacheControl({ system: outputSystem, messages, tools })
  ) {
    const cache = { type: "ephemeral", ttl: "1h" }
    const identityEntry = outputSystem[1]
    if (identityEntry) identityEntry.cache_control = cache
    const lastSystem = outputSystem.at(-1)
    if (lastSystem && lastSystem.type === "text" && lastSystem.text !== "")
      lastSystem.cache_control = cache
    // Native system breakpoints cache the tools prefix too. Do not spend a breakpoint on tools.
    const last = messages.at(-1)
    if (last) {
      if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }]
      const tail = last.content.at(-1)
      if (tail && !["thinking", "redacted_thinking"].includes(tail.type)) tail.cache_control = cache
    }
  }
  body.stream = true
  return {
    text: stampIntegrity(body, CLAUDE_FAST_CLI_VERSION),
    streaming: original.stream === true,
    sessionId,
    promptId: origin || subagent ? promptId : undefined,
    subagent,
  }
}

function hasCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCacheControl)
  if (value === null || typeof value !== "object") return false
  return Object.entries(value).some(
    ([key, nested]) => key === "cache_control" || hasCacheControl(nested),
  )
}
function textOf(value: FastRequest["messages"][number]["content"] | undefined): string {
  if (typeof value === "string") return value
  const text = value?.find(
    (entry) =>
      entry.type === "text" &&
      typeof entry.text === "string" &&
      !entry.text.startsWith("<system-reminder>"),
  )?.text
  return typeof text === "string" ? text : ""
}
