# Security Policy

## Supported versions

Self-hosted software, one running version per deployment — there is no LTS branch to track. Security
fixes land on `main` and ship in the next tagged `v*` release. Only the latest tagged release is
supported; upgrade to it before reporting an issue against an older tag.

## Reporting a vulnerability

**Report privately, through GitHub Security Advisories — do not open a public issue.**

Use [Report a vulnerability](https://github.com/developerz-ai/multi-ai-router/security/advisories/new)
on this repository (requires the advisory feature to be enabled in the repo settings; see below). This
opens a private advisory visible only to maintainers until a fix is ready, so a live exploit path
isn't disclosed while it's still exploitable.

Include what you'd want if you were on the other end: affected version/commit, reproduction steps,
and impact (what an attacker gains — see the threat model and blast-radius table in
[`docs/idea/07-security.md`](docs/idea/07-security.md) for the shapes we already reason about, e.g.
`ENCRYPTION_KEY` exposure, admin-plane access, or the Agent-SDK tool-execution path).

## Response

- Acknowledgement: within **3 business days**.
- Triage and severity call: within **7 days** of acknowledgement.
- Fix or mitigation timeline communicated once triaged; critical issues (anything reaching the
  blast-radius table's higher rows — credential exposure, host tool execution) are prioritized over
  everything else in flight.

## Scope

This is self-hosted software with a **single admin**, run by whoever deploys it — there is no
multi-tenant hosted service and no bug bounty program.

In scope:
- The router itself: data plane (`/v1/**`), admin plane (`/api/admin/**`), the Agent-SDK tool
  passthrough path, credential handling, redaction, and the provider drivers in this repository.

Out of scope:
- Deployment mistakes covered by the [hardening checklist](docs/idea/07-security.md#hardening-checklist)
  — e.g. publishing the admin plane to the public internet, running without a reverse proxy in front,
  or losing `ENCRYPTION_KEY`. **The admin plane is documented as not-internet-facing**; exposing it
  yourself is an operator decision, not a router vulnerability.
- Vulnerabilities in upstream providers (Anthropic, OpenAI, etc.) — report those to the provider.
- Social engineering, physical access, or anything requiring prior compromise of the host itself.

Full threat model, redaction rules, and secrets handling: [`docs/idea/07-security.md`](docs/idea/07-security.md).
