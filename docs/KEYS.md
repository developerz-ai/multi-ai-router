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
   memory, so N replicas together admit up to N times the ceiling. Over it the key gets `429`
   `key_rate_limited`.
5. Optionally set an expiry (`expiresAt`). Keys have no expiry by default.

An attribution field can be changed later with **Edit** (`PATCH /api/admin/keys/:id`); `null`
clears it. Editing never changes the key's value. Like a revoke, an edit (a narrower scope, a new
rate limit) takes effect at once on the replica that handled it and on the others within
`KEY_CACHE_TTL_SECONDS`.

### Client setup

Send the key as `Authorization: Bearer mar_live_<...>` or as `x-api-key: mar_live_<...>`. Never send
both with different values: the request is refused. The per-client recipes are in
[`clients.md`](clients.md). The console's **Point your tool at it** panel shows the same recipes
filled in; do not copy those prefilled values into tickets or chat.

### Rotate

There is no rotate endpoint, by design (`updateKeyBody` in
`apps/api/src/services/keys/schemas.ts`): a key you can re-read does not need one.

This is planned rotation, where the old key stays live until the client has moved. For a leaked or
lost key, use [Leaked or lost key](#leaked-or-lost-key) instead.

1. On the old key's row, choose **Mint successor**. The mint form opens prefilled with the
   attribution, scope and rate limit. The value is never copied and the expiry is not inherited:
   set it again if the old key had one.
2. Give the successor its own name, such as `<owner>/<tool>-2` or a date suffix. Names are unique
   and the old key keeps its name, revoked or not, until it is purged; reusing it answers `409`.
   Mint it, then give the new value to the client and swap it in.
3. Watch the **Last used** column: the old key's should stop advancing and the new key's should
   start. Last-used is stamped on a verified cache miss, so it moves about once per
   `KEY_CACHE_TTL_SECONDS` per replica (default 60), not on every request.
4. **Revoke** the old key.

Rotate a key that is still needed when someone who has seen its value leaves (a shared service key,
for example). A key whose holder leaves, or whose tool is retired, is not rotated: it is handed
back, which means revoked (see [Hand back is revoke](#hand-back-is-revoke)). There is no scheduled
rotation: a key does not expire unless you set one.

### Leaked or lost key

When a device is lost, a key is pasted somewhere public, or a leak is suspected, revoke first and
accept that the client stops working until it gets a successor. Waiting for **Last used** to settle
does not work here: whoever holds the leaked key keeps it advancing.

1. **Revoke** the key now.
2. On a deployment with more than one replica, the others keep accepting the key for up to
   `KEY_CACHE_TTL_SECONDS`. If that window is longer than a roll of every replica takes, roll them
   all: a restart empties a replica's key cache. A roll gives in-flight requests on each replica up
   to `SHUTDOWN_DRAIN_MS` to finish and then ends the rest (long streams included), for every key,
   and resets every key's in-memory rate-limit window, so at the 60-second default waiting is
   usually the better choice. A single replica needs nothing here.
3. **Mint successor**, under a new name, and hand it over privately.

### Revoke

Console: **Revoke** on the key's row. API: `POST /api/admin/keys/:id/revoke`.

- The next request on the replica that handled the revoke gets `401` `key_revoked`.
- Other replicas keep accepting the key for up to `KEY_CACHE_TTL_SECONDS` (default 60 seconds). That
  setting is the bound; read it from your own environment. Rolling every replica drops their caches
  at once, at the cost described under [Leaked or lost key](#leaked-or-lost-key). Lowering the
  setting needs a restart too, and only shortens future windows, at a database round trip per
  uncached verification.
- In-flight requests finish. A stream is not torn down.
- Revocation is one-way. A revoked key is never reactivated.
- A revoked key keeps its row, scope and usage attribution until `RETENTION_REVOKED_KEYS_DAYS`
  (default 30) after revocation. Then the row is purged and a tombstone keeps its name, owner and tool,
  so its usage stays attributed for `RETENTION_USAGE_DAILY_DAYS` (default 730) plus one day.

### Hand back is revoke

When a key is handed back, revoke it. Do not use **Delete** (`DELETE /api/admin/keys/:id`) for this:
a revoked key stays listed, with its scope and limits visible, for `RETENTION_REVOKED_KEYS_DAYS`,
while a delete removes the row at once. Either way its usage stays attributed through its
tombstone.

## Requester

1. **Ask** the operator for a key. Say who it is for (the `owner`), whether that is a person or a
   service, which tool will use it (the `tool`), and what it is for (the `purpose`). Ask for a
   scope that covers only what you need.
2. **Receive** it from the operator over a private channel. The value is `mar_live_<...>`; treat it
   as a password. Do not commit it, paste it into a ticket or a chat room, or put it in a shared
   shell history.
3. **Configure** your tool with `<router-url>` as the base URL and the key as its API key. See
   [`clients.md`](clients.md) for the recipe and a verification command.
4. **Rotate** when the operator asks: take the successor key, swap it in, and tell the operator so
   they can revoke the old one. If a device is lost or the key leaks, tell the operator at once;
   they revoke it first, and you wait for the successor.
5. **Hand back** by telling the operator you no longer need it. They revoke it.

## Errors a key holder sees

This is the key, scope and capacity subset of what the data plane can return, not every status. The
error class table is in
[`packages/core/README.md`](../packages/core/README.md#errors--each-class-fixes-its-code-and-status-at-declaration-not-at-the-call-site).

| Status | Meaning |
|---|---|
| 401 `key_revoked` | revoked, unknown, expired, malformed or missing key, or Bearer and `x-api-key` disagree |
| 402 `credits_exhausted` | an account is out of credits. Do not retry: it stays this way until the operator tops it up |
| 403 `scope_violation` | the key's scope reaches no account (a narrow scope, or a pool with no members). Do not retry: ask the operator |
| 429 `key_rate_limited` / `quota_exhausted` | the key's rate limit, or accounts cooling (clock-recoverable); with `Retry-After` |
| 503 `key_verification_unavailable` | transient; retry after `Retry-After: 1`, a bounded number of times |
| 503 `no_healthy_account` | nothing in scope can serve this request; read the message (below). No `Retry-After` |

For `no_healthy_account`, the message names the cause:

- A model no in-scope account serves: a client change. Pick another model, or ask the operator for
  a wider scope.
- A missing endpoint, or a misconfigured account: an operator fix.
- "every attempt failed": may clear on retry. Back off (exponential, bounded) rather than retry at
  once.
- Anything else, including an account that is disabled or needs re-auth: the operator.

A revoked key and a never-existed key look the same (`401`). If you were working an hour ago,
assume the key was revoked or rotated and ask the operator.

## Where your usage shows

Today, on the console's **Keys** page:

- the per-key usage and cost columns, for the selected window;
- the **Last used** column;
- the owner and tool filters, which narrow the loaded list in the browser (exact match,
  combinable). Scripts use `GET /api/admin/keys?owner=<owner>&tool=<tool>` with the same rule; a
  value that is not a valid slug answers `400` there.

On the console's **Usage** page:

- a **Break down by** switch with **Owner** and **Tool** beside Key, Account, Pool and Model. An
  owner row shows its kind (`person`, `service`, or `unknown` when the key names none), so a person
  and a service called the same thing are two rows. Keys with no owner or tool land in an
  `unassigned` row, and spend whose key is gone in `deleted` and `none` rows;
- **Owner**, **Tool** and **Model** filters, which narrow every figure on the page (and the
  **Export CSV** link, which carries them). The view is in the URL, so a link restores it:
  `/usage?window=30d&owner=alice&tool=editor`, repeating a name for several values;
- an **Unpriced attempts** tile, a dash when the window predates measurement;
- the stored **weekly reports** and where delivery of each stands, read-only.

Metered and notional spend are separate everywhere on that page and are never added together.
