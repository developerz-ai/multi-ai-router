# Router keys: operator and requester runbook

A router key (`mar_live_<...>`) is what a person, tool or service presents to `<router-url>/v1/**`.
This page is the practical lifecycle: mint, hand over, rotate, revoke, and what a key holder sees
when a request fails. The contract behind it (storage, verification, scope) is
[`docs/idea/04-api-keys-and-access.md`](idea/04-api-keys-and-access.md). Every value below is a
placeholder.

Keys are stored encrypted and are retrievable from the console at any time. Nothing here is
"shown once".

## Operator

### Mint

Console: **Keys**, then **Mint key**. API: `POST /api/admin/keys` on the admin plane (session cookie
plus CSRF token, or `ADMIN_API_TOKEN`).

1. **Name** the key `<owner>/<tool>`. The name is free text and the convention is only
   documentation, but it is how you find the key later.
2. Fill the attribution fields, which feed usage reporting and change nothing about
   authentication:
   - `owner`: who the key was issued to. A slug: lowercase `a-z`, `0-9`, `.`, `_`, `-`, starting
     with a letter or digit, at most 64 characters. The API answers `400` on anything else.
   - `ownerKind`: `person` or `service`.
   - `tool`: what runs on the key. Same slug rule as `owner`.
   - `purpose`: free text, up to 500 characters.
3. **Scope** the key to a pool rather than `all`. The three forms are `all`, one or more pools, or
   an explicit account list. Leaving `scope` out of a create request means `all`. Scope is
   intersected with pool membership and never widened.
4. Optionally set a **rate limit**: `requests` per `windowSeconds`. It is enforced per replica, in
   memory. Over the ceiling the key gets `429` `key_rate_limited`.
5. Optionally set an expiry (`expiresAt`). Keys have no expiry by default.

An attribution field can be changed later with **Edit** (`PATCH /api/admin/keys/:id`); `null`
clears it. Editing never changes the key's value.

### Client setup

Send the key as `Authorization: Bearer mar_live_<...>` or as `x-api-key: mar_live_<...>`. Never send
both with different values: the request is refused. The per-client recipes are in
[`clients.md`](clients.md). The console's **Point your tool at it** panel shows the same recipes
filled in; do not copy those prefilled values into tickets or chat.

### Rotate

There is no rotate endpoint, by design (`updateKeyBody` in
`apps/api/src/services/keys/schemas.ts`): a key you can re-read does not need one.

1. On the old key's row, choose **Mint successor**. The mint form opens prefilled with the
   attribution, scope and rate limit. The value is never copied and the expiry is not inherited.
2. Mint it, then give the new value to the client and swap it in.
3. Watch the **Last used** column: the old key's should stop advancing and the new key's should
   start. Last-used is stamped on a verified cache miss, so it moves about once per
   `KEY_CACHE_TTL_SECONDS` per replica (default 60), not on every request.
4. **Revoke** the old key.

Rotate when someone leaves, when a device is lost, when a key is pasted somewhere public, or when
a leak is suspected. There is no scheduled rotation: a key does not expire unless you set one.

### Revoke

Console: **Revoke** on the key's row. API: `POST /api/admin/keys/:id/revoke`.

- The next request on the replica that handled the revoke gets `401` `key_revoked`.
- Other replicas keep accepting the key for up to `KEY_CACHE_TTL_SECONDS` (default 60 seconds). That
  setting is the bound; read it from your own environment. There is no faster path than lowering
  it, which costs a database round trip per uncached verification.
- In-flight requests finish. A stream is not torn down.
- Revocation is one-way. A revoked key is never reactivated.
- A revoked key keeps its row, scope and usage attribution until `RETENTION_REVOKED_KEYS_DAYS`
  (default 30) after revocation. Then it is purged and its usage rows lose the key.

### Hand back is revoke

When a key is handed back, revoke it. Do not use **Delete** (`DELETE /api/admin/keys/:id`): a hard
delete removes the row at once and its past usage loses attribution immediately.

## Requester

1. **Ask** the operator for a key. Say who it is for (the `owner`), whether that is a person or a
   service, which tool will use it (the `tool`), and what it is for (the `purpose`). Ask for a
   scope that covers only what you need.
2. **Receive** it from the operator over a private channel. The value is `mar_live_<...>`; treat it
   as a password. Do not commit it, paste it into a ticket or a chat room, or put it in a shared
   shell history.
3. **Configure** your tool with `<router-url>` as the base URL and the key as its API key. See
   [`clients.md`](clients.md) for the recipe and a verification command.
4. **Rotate** when the operator asks, or yourself when a device is lost or the key leaks: tell the
   operator, take the successor key, swap it in, and let them revoke the old one.
5. **Hand back** by telling the operator you no longer need it. They revoke it.

## Errors a key holder sees

This is the key, scope and capacity subset of what the data plane can return, not every status. The
full error table (every class, code and status) is in
[`packages/core/README.md`](../packages/core/README.md#errors--each-class-fixes-its-code-and-status-at-declaration-not-at-the-call-site).

| Status | Meaning |
|---|---|
| 401 `key_revoked` | revoked, unknown, expired, malformed or missing key, or Bearer and `x-api-key` disagree |
| 402 `credits_exhausted` | an account is out of credits |
| 403 `scope_violation` | nothing is in scope |
| 429 `key_rate_limited` / `quota_exhausted` | the key's rate limit, or accounts cooling (clock-recoverable); with `Retry-After` |
| 503 `key_verification_unavailable` | transient; retry after `Retry-After: 1` |
| 503 `no_healthy_account` | nothing in scope can serve this request; read the message (below). No `Retry-After` |

For `no_healthy_account`, the message names the cause:

- A model no in-scope account serves: a client change. Pick another model, or ask the operator for
  a wider scope.
- A missing endpoint, or a misconfigured account: an operator fix.
- "every attempt failed": may clear on retry.
- Anything else, including an account that is disabled or needs re-auth: the operator.

A revoked key and a never-existed key look the same (`401`). If you were working an hour ago,
assume the key was revoked or rotated and ask the operator.

## Where your usage shows

Today, on the console's **Keys** page:

- the per-key usage and cost columns, for the selected window;
- the **Last used** column;
- the owner and tool filters, which are the console's door to
  `GET /api/admin/keys?owner=<owner>&tool=<tool>` (exact match, combinable; a value that is not a
  valid slug answers `400`).

The Usage page broken down by owner and tool, and a weekly report, extend this section when they
land.
