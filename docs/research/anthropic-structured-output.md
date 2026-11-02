# Anthropic structured outputs (the Messages API contract)

The authoritative record of **Anthropic's own structured-output field**, the shape it takes, and
the router rule derived from it. Captured 2026-11-02 from Anthropic's published documentation.
No real credentials or captures live here.

This page exists because the router must **refuse** a constraint it cannot carry, and a refusal
can only name a field if the field's name is a fact rather than a guess. Anthropic has published
**two spellings** of one feature, and the wire field and the SDK parameter name are not the same
string.

## The contract

| | |
|---|---|
| Field, current | `output_config.format` — a request field of the Messages API, sibling of `output_config.effort` |
| Field, deprecated | `output_format` — the beta-era spelling; still accepted **only** with the `structured-outputs-2025-11-13` beta header, otherwise the API answers `400` |
| Shape | `{ "type": "json_schema", "schema": { …JSON Schema… } }` |
| Where the answer comes back | the response's **text content block**, holding JSON that matches the schema |

A request carrying it, as Anthropic's own documentation shows it:

```json
{
  "model": "claude-opus-5-5",
  "max_tokens": 1024,
  "messages": [{ "role": "user", "content": "…" }],
  "output_config": {
    "format": {
      "type": "json_schema",
      "schema": {
        "type": "object",
        "properties": {
          "summary": { "type": "string" },
          "next_steps": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["summary", "next_steps"],
        "additionalProperties": false
      }
    }
  }
}
```

## What the source says

From Anthropic's *Structured outputs* page (the canonical URL below), quoted:

> The request carries the schema in `output_config.format` with `type: "json_schema"`. SDK helpers
> set this for you.

> The `output_format` parameter has moved to `output_config.format`, and beta headers are no longer
> required. The `output_format` parameter is deprecated. To use it anyway, add the
> `structured-outputs-2025-11-13` beta header. Without it, the API returns a 400 error.

> The Python SDK (v1.0 and later) does not accept `output_format={...}` on
> `client.beta.messages.create()` or `count_tokens()` and raises a `TypeError`. Use `output_config`
> instead.

> Pass a Pydantic model to `client.messages.parse()`, the recommended method, as `output_format`.
> The SDK transforms the model's schema, sends it as `output_config.format`, validates the
> response, and returns the parsed model in `parsed_output`.

**The SDK-level name and the wire name are not the same thing.** `client.messages.parse(
output_format=…)` takes the constraint under the *deprecated* spelling and sends it as
`output_config.format`. A client that reaches this router through Anthropic's own SDK therefore
arrives carrying **`output_config.format`**, not `output_format` — which is why both spellings are
refused, each named as the caller wrote it.

Also stated on the page, and relevant to what the router may claim about the feature:

- **Availability** — Messages API, every model, all supported cloud platforms; *not* available on
  Managed Agents.
- **Data handling** — zero-data-retention eligible (qualified); only the JSON schema is cached, for
  up to 24 hours since last use.
- **Prompt cache** — "Changing the `output_config.format` parameter will invalidate any prompt
  cache for that conversation thread."
- **Cost** — the schema is compiled to a grammar, so the first request with a given schema pays
  extra latency, and Claude receives an additional system prompt describing the expected output
  format (so input tokens are slightly higher).
- **JSON Schema limitations** — a documented subset (no external `$ref`, `allOf` without `$ref`
  unsupported, `additionalProperties` must be `false` for objects, and so on). The router does not
  validate the schema and does not need to: it refuses the constraint by **presence**, never by
  inspecting its contents.

## Blast radius if Anthropic renames or graduates it

The field has already moved once (`output_format` → `output_config.format`), so assume it moves
again. What breaks, and where:

- **A renamed field is dropped, silently.** `anthropicRequestSchema` strips top-level keys it does
  not name, so a request carrying a *third* spelling of the constraint would parse, translate, and
  reach the upstream with no constraint at all — the upstream answers in prose and the caller's
  `JSON.parse` fails naming nothing. That is the defect the refusal exists to prevent.
- **Therefore the field is named in the schema on purpose.** `output_config.format` and
  `output_format` are declared in `services/translate/shared/anthropic.ts` purely so they can be
  **refused by name**; the rule lives in `services/translate/shared/reject.ts`
  (`assertNoAnthropicStructuredOutput`). A new spelling must be added there, or it is dropped.
- **Graduating out of beta breaks callers, not the router.** With the beta header gone, a client
  still sending `output_format` gets Anthropic's own `400` on the wire. The router's rule is
  unchanged — refuse a constraint it cannot carry — but the set of spellings a client may still
  send narrows over time.
- **A new shape under the same name is still refused.** The rule decides on **presence**, so a
  constraint of a shape this build has never seen (`type` other than `json_schema`, a `name`, a
  `description`) is refused by name rather than half-carried.
- **The message must never quote the schema.** A refused request may carry anything, and an error
  body is a client-facing surface that credential material must never reach
  (`docs/idea/07-security.md`). Only field names are quoted back.

## The router rule

1. **A constraint is a contract.** Dropped, it fails at the *caller's* `JSON.parse` with nothing
   naming the cause — an OpenAI SDK `.parse()`, LangChain's `withStructuredOutput()`, Instructor,
   `generateObject` all hand back prose and a parse error instead of a `400` the caller can act
   on. Refused, the caller gets a `400` naming the field it has to change.
2. **No carrier exists for a constraint that starts in the anthropic dialect.** The two carriers in
   this build run the other way: openai-chat `response_format` → openai-responses `text.format`, and
   openai-chat `response_format` → anthropic as a forced tool call. So on every **HTTP translation
   hop** out of `anthropic` — `anthropicToOpenAiChatRequest` and `anthropicToOpenAiResponsesRequest`
   — the constraint is **refused** with a `400`, before any upstream call, by
   `assertNoAnthropicStructuredOutput`. The Agent-SDK egress is a re-synthesis rather than a
   translation and states no such option at all, so the constraint is dropped there today — the
   same gap on the one column that cannot carry it.
3. **Absent and `null` state nothing and pass.** A caller that never asked for a constrained answer
   must not be refused over it, and `output_config` without a `format` is the reasoning dial
   (`output_config.effort`), which is carried, not refused.
4. **A same-dialect anthropic body is relayed untouched.** Passthrough never parses the body
   (non-negotiable 10), so an `anthropic-api` account receives `output_config.format` /
   `output_format` exactly as the client wrote it, and Anthropic enforces the constraint itself.
   This path is the one place the feature works.
5. **The refusal names the field, never its value.** `output_format` and `output_config.format`
   are each refused under the name the caller used, because that is the name the caller has to
   change.

## Sources

- Anthropic, *Structured outputs* (Messages API) — https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  — **checked 2026-11-02**. The older `https://docs.anthropic.com/en/docs/build-with-claude/structured-outputs`
  redirects here; the text above is from the redirected page.
- Anthropic, *Strict tool use* — the same `output_config.format` grammar pipeline, `strict: true`
  on a tool — https://platform.claude.com/docs/en/build-with-claude/structured-outputs#strict-tool-use
  — checked 2026-11-02.
