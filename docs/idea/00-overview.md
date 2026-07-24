# multi-ai-router — Overview

Status: the product boundary and the non-goals are settled and hold. What is *built* is in the
[README's status table](../../README.md#-status) — in short, the admin API and same-dialect
passthrough work; translation, the Agent-SDK path, and the console's screens do not.

## The problem

| Symptom | Cost today |
|---|---|
| Every developer buys their own Claude Max / ChatGPT / Copilot seat | N subscriptions for a team that rarely saturates one |
| The subscriptions you already own sit idle in one window and rate-limited in the next | No way to make five Claude Max subs behave like one account that never runs out |
| AI agents need credentials to call models | Real upstream keys get copied into fleets of agents, and cannot be revoked individually |
| Nobody knows who spent what | No shared view of tokens, cost, error rate, or which account is rate-limited right now |
| Subscription OAuth tokens expire | Manual re-login, on every machine that holds a copy |

## The solution

A self-hosted **API router** that lets a team of developers and AI agents share a pool of AI
subscriptions and API keys behind a single endpoint. You log in as the single admin, attach
upstream accounts (Claude Max/Pro OAuth, ChatGPT/Codex OAuth, Anthropic API, OpenAI API,
OpenRouter, z.ai, Kimi, MiniMax, Gemini, any OpenAI- or Anthropic-compatible endpoint), then mint
API keys and bind each key to the accounts it may use. Clients — Claude Code, OpenCode, Codex CLI,
Cline, Aider, anything that speaks the OpenAI or Anthropic wire protocol — point at the router with
one of its keys. The router selects an account, presents the real upstream credential, refreshes
OAuth in the background, and records usage.

**Pooling is the product.** Many accounts of the *same* provider is the normal case, not an edge
case — five Claude Max subscriptions, three z.ai keys, and two ChatGPT subs side by side. A Pool is
how "my five Claude subs plus the OpenRouter key as a safety net" becomes one addressable thing a
key can point at. Everything else here — routing policies, failover, quota awareness, per-key
scoping — exists to make a Pool behave like a single, more reliable account than any of its members.
Nothing in the model, the UI, or the routing assumes one account per provider.

```
Claude Code / OpenCode / Codex / any OpenAI|Anthropic client
        │  (router-issued API key)
        ▼
   multi-ai-router  ── selects account from the key's pool, presents the real
        │              upstream credential, refreshes OAuth, records usage
        ▼
Claude Max sub · ChatGPT sub · Anthropic API · OpenRouter · z.ai · Kimi · …
   (Agent SDK)      ────────── HTTP drivers ──────────
```

Claude Max/Pro subscriptions are the one exception to "inject a credential and forward the bytes":
they run through the first-party **Claude Agent SDK**, with one isolated config directory per
account and no token extraction. That is a deliberate account-safety decision — see
[11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md).

## Who it's for

- Small teams sharing a handful of paid subscriptions instead of buying one per seat.
- Fleets of AI agents that need a stable endpoint and a revocable key each.
- Anyone who wants per-key, per-account usage and cost accounting.

## The central invariant

> **The client picks the model. The router picks the account.**

That is the whole boundary, and every other rule descends from it.

| Side of the line | Owns | Never does |
|---|---|---|
| Client | the model name, the prompt, the tools, the dialect it speaks | know which account served it |
| Router | which account serves the request, the credential, retries, failover, accounting | rewrite, re-rank, or second-guess the requested model |

What the split buys:

| Property | Because |
|---|---|
| Predictable output | The model you asked for is the model you got. No silent downgrade, no cost-driven substitution. |
| Drop-in adoption | A client changes one base URL and one key. No SDK, no prompt changes. |
| Revocation without redeployment | Keys are router-issued. Revoke one agent's key; no upstream credential moves or rotates. |
| Honest accounting | Every request is attributable to (key, account, session, model) because the router chose the account. |
| A pure selection core | Choosing an account is a decision over health and policy, not over prompt content — so it is a pure function, and testable with no mocks. See [05-routing-and-failover.md](05-routing-and-failover.md). |
| Near-zero overhead | Nothing in the hot path inspects the prompt, so the router is a header swap and a byte relay: a budget of under 5 ms added p99 and no added time-to-first-token. See [01-architecture.md](01-architecture.md). |

## Non-goals

These define the product as much as the features do.

| Not | Meaning |
|---|---|
| **A model picker / semantic router** | No "cheapest model for this prompt" logic. The client sends a model name; we honor it. |
| **A prompt / agent framework** | No tool execution, no memory, no RAG. Bytes in, bytes out. |
| **Multi-tenant SaaS** | One admin, one org, self-hosted. No user accounts, no billing, no org hierarchy in v1. |
| **A caching layer** | Prompt caching stays the upstream's job — and it is per-account, which is why routing is sticky by default. |
| **A credential exfiltration tool** | Upstream credentials never leave the router. No endpoint returns them. See [07-security.md](07-security.md). |

## Concepts at a glance

| Concept | One line |
|---|---|
| **Provider** | A *kind* of upstream (`anthropic-oauth`, `openai-api`, `openrouter`, …) — a static, code-defined registry. Many Accounts per Provider is the normal case. |
| **Account** | One credential to one Provider, with a human label, weight, priority, health, an optional model alias map, and a status that separates a rate-limited window (`cooling_down`, refills on a clock) from a drained balance (`exhausted`, needs you). |
| **Pool** | An ordered/weighted set of Accounts plus a load-balancing policy — the unit the product is built around. An Account may sit in several Pools. |
| **ApiKey** | A named, router-issued credential (`mar_live_…`), stored encrypted and viewable and copyable from the UI at any time — never hashed, never shown once. Scoped to `all` accounts, to Pools, or to an explicit account list. Revocable. |
| **Session** | A conversation identity used for sticky routing and usage attribution; ephemeral, retained on a TTL. |

Full field tables, relations, and lifecycles: [02-domain-model.md](02-domain-model.md).

## Read next

| Doc | Covers |
|---|---|
| [01-architecture.md](01-architecture.md) | Request lifecycle, layers, repo layout, dependency rules, extension points |
| [02-domain-model.md](02-domain-model.md) | Entities, relations, state machines, lifecycles |
| [03-providers.md](03-providers.md) | Provider registry, driver interface, per-provider constants and OAuth flows |
| [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md) | Claude subscriptions via the Claude Agent SDK: per-account config dirs, quota events, costs |
| [05-routing-and-failover.md](05-routing-and-failover.md) | Filter → policy → failover chain, the six policies, circuit breaker |
| [06-protocol-translation.md](06-protocol-translation.md) | Ingress × egress matrix, passthrough, documented lossy edges |
| [07-security.md](07-security.md) | Encryption at rest, retrievable router keys, redaction, rate limits, framing |
