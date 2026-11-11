/**
 * A prod-shaped request body: what a coding agent sends on its fortieth turn, not a 1 KB `"x"`.
 *
 * The body scanner's cost is a function of the bytes' *shape*, not only their count: one long
 * escape-free string is its single fast path, while escaped code (`\n`, `\"` every few characters)
 * and structure-dense tool inputs and schemas are the slow ones. A bench body of `"x".repeat(n)`
 * measures the fast path and nothing else, so prod ran 4–8× the bench at the same size
 * (plan 101, 10.2 / 02.13). This builds the shapes Claude Code actually posts: a cached system
 * prompt, a tool list with JSON schemas, and a transcript of assistant `tool_use` blocks carrying
 * file edits, answered by `tool_result` blocks carrying source text — grown until it reaches the
 * requested size. Deterministic, so two runs bench the same bytes.
 */

const CODE_LINE =
  'export function handle(request: Request): Response {\n\tconst value = request.headers.get("x-trace")\n\treturn new Response(JSON.stringify({ ok: true, value }), { status: 200 })\n}\n'

const TOOLS = ["Read", "Edit", "Bash", "Grep", "Glob", "Write"].map((name) => ({
  name,
  description: `${name} a file or run a command in the workspace. Paths are absolute.`,
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      options: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1 }, replace_all: { type: "boolean" } },
      },
    },
    required: ["file_path"],
  },
}))

function codeText(lines: number, seed: number): string {
  let text = ""
  for (let line = 0; line < lines; line += 1) text += `// ${seed}.${line}\n${CODE_LINE}`
  return text
}

/** One assistant tool call and the user turn answering it — the unit a transcript grows by. */
function turn(index: number): readonly unknown[] {
  const id = `toolu_${index.toString(16).padStart(8, "0")}`
  return [
    {
      role: "assistant",
      content: [
        { type: "text", text: `Step ${index}: editing the handler to carry the trace header.` },
        {
          type: "tool_use",
          id,
          name: "Edit",
          input: {
            file_path: `/workspace/src/routes/handler-${index}.ts`,
            old_string: codeText(2, index),
            new_string: codeText(3, index),
            options: { replace_all: false, limit: index + 1 },
          },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: id, content: codeText(6, index) },
        { type: "text", text: "<system-reminder>\nKeep going.\n</system-reminder>" },
      ],
    },
  ]
}

/** An Anthropic Messages body of at least `bytes` bytes, shaped like a long agent session. */
export function transcriptBody(input: {
  readonly model: string
  readonly bytes: number
  readonly stream: boolean
}): string {
  const messages: unknown[] = [{ role: "user", content: "Add trace propagation to every route." }]
  const frame = (list: readonly unknown[]) =>
    JSON.stringify({
      model: input.model,
      max_tokens: 4_096,
      system: [
        {
          type: "text",
          text: `You are a coding agent.\n${codeText(4, 0)}`,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: TOOLS,
      messages: [
        ...list,
        {
          role: "user",
          content: [{ type: "text", text: "Continue.", cache_control: { type: "ephemeral" } }],
        },
      ],
      ...(input.stream ? { stream: true } : {}),
    })
  // Each turn's own serialization (plus its two separating commas) is what it adds to the frame.
  let size = frame(messages).length
  for (let index = 1; size < input.bytes; index += 1) {
    const next = turn(index)
    messages.push(...next)
    size += JSON.stringify(next).length
  }
  const body = frame(messages)
  return body
}
