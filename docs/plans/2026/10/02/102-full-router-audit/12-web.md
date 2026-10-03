# 12 — Operator console

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/web/`. API contract additions, if needed for verified OAuth completion, are handed to the transport/auth owner rather than edited by this slice.

## Findings

### 12.1 medium — An incomplete key rate limit silently removes the limit

- **Where:** `apps/web/src/routes/keys/KeyFormDialog.tsx:115`.
- **Defect:** `rateLimit()` returns `null` when either input is empty, conflating a half-entered limit with an intentional removal.
- **Failure scenario:** Edit a key limited to 60 requests/60 seconds, clear only its window, save → PATCH sends `rateLimit:null` and the key becomes unlimited. On mint, entering only Requests=60 silently creates an unlimited key.
- **Evidence:** Mounted actual dialog with Name=test, Requests=60, empty Per → `form.checkValidity()` was `true`; submit emitted `{"name":"test","scope":{"kind":"all"},"rateLimit":null,"expiresAt":null}`. Both fields are optional in the DOM, so browser validation does not prevent it.
- **Fix:** Treat both-empty, both-valid and incomplete as separate states; incomplete blocks submission with field-specific feedback. Only both-empty clears an existing limit. Document console validation in `docs/idea/04-api-keys-and-access.md`.
- **Test:** Failure first in `apps/web/test/unit/KeyFormDialog.test.tsx`: clearing only count or only window on a limited key emits no mutation and shows feedback; same for half-filled mint. Both-empty still explicitly clears and a complete pair preserves its numbers.

### 12.2 medium — A timestamp change is falsely reported as successful OAuth authorization

- **Where:** `apps/web/src/routes/accounts/AccountConnect.tsx:107`.
- **Defect:** The completion effect equates any change to `account.updatedAt` with successful redirect authorization without checking a matching completed login.
- **Failure scenario:** Start a redirect login on a `needs_reauth` account; another operator renames it, or a background refresh/status write updates its row before authorization → the dialog hides the URL/paste form and claims the account can serve requests although no credential was obtained. Its completed flag also prevents cancel-on-close.
- **Evidence:** Stubbed only the router API: POST start returned redirect capture; GET account returned a renamed row still `needs_reauth`, `hasCredential:false`, with a newer timestamp. The mounted dialog rendered `Connected. This account can serve requests again` and removed the authorization URL.
- **Fix:** Obtain a positive completion signal bound to this login attempt, not a generic account timestamp. Coordinate a non-secret attempt-status contract with the connect API owner if existing responses cannot establish that identity. Keep pending state on unrelated writes; restrict redirect observation to redirect capture and the same account/attempt.
- **Test:** Failure first in `apps/web/test/unit/AccountConnect.test.tsx`: changed label/status/model metadata must not complete; matching authorization success does. Cover reconnect on an account already holding credentials, stale detail-cache rows, different account ids, and paste-only mode. All upstreams mocked. Update `docs/idea/03-providers.md` connect flow contract.

### 12.3 medium — Stopping a reconnect sequence starts another login on its first account

- **Where:** `apps/web/src/routes/accounts/ReconnectSequence.tsx:53`; triggered by `apps/web/src/routes/accounts/AccountConnect.tsx:93`.
- **Defect:** `close()` resets the cursor before closing the sequence, exposing account zero to the reactive auto-begin effect for one update.
- **Failure scenario:** Reconnect two accounts, skip the first, press Stop on the second → account two is cancelled but a fresh login starts on account one after the operator stops. The dialog closes before the new response can be cancelled; its server-side login/subprocess survives until expiry.
- **Evidence:** Mounted sequence with mocked API produced exactly `POST account1/connect`, `DELETE account1/connect`, `POST account2/connect`, `DELETE account2/connect`, **`POST account1/connect`**, with the dialog closed afterward.
- **Fix:** Atomically close/reset or suppress auto-begin while closing, so no intermediate account is observable. Also ensure a start that resolves after the owning dialog closes is retired, not left pending. Preserve the existing fix preventing duplicate starts on ordinary account refetches.
- **Test:** Failure first: Stop, last Skip, last Finish and modal dismissal from a nonzero cursor must never emit another POST; pending work is cancelled once. Cover delayed begin responses and reopening the sequence. Update reconnect lifecycle in `docs/idea/03-providers.md`.

### 12.4 medium — Editing a price destroys the focused input on every keystroke

- **Where:** `apps/web/src/routes/settings/PriceOverridesSection.tsx:69`; reference-keyed rendering at `apps/web/src/components/Table.tsx:91`.
- **Defect:** Every draft edit rebuilds every `PriceRow` object, causing Solid's reference-keyed row loop to unmount the input being edited.
- **Failure scenario:** Focus a price cell and begin typing a multi-digit rate → the first input event replaces the element and loses focus, so subsequent typing no longer edits that cell; IME/caret state is also discarded.
- **Evidence:** Mounted real price editor with mocked settings; after typing one edit, original input `isConnected:false`, replacement was a different node, and the replacement did not have focus. Entered text survived in state, but its active control did not.
- **Fix:** Keep row identity stable independently of draft values, or render rows by stable ids with reactive accessors. Keep column definitions stable as needed; do not solve with forced refocus after each replacement. Cover sorting/filtering and background settings refresh. Update console interaction notes in `docs/idea/08-observability.md`.
- **Test:** Failure first: real mounted editor accepts consecutive keystrokes in the same DOM input, retains focus/caret, and updates the proposed payload. Editing one cell leaves other rows mounted. Existing filtering, unsaved draft and pricing tests pass.

### 12.5 medium — Valid exponent-form numeric input is saved as a different number

- **Where:** `apps/web/src/routes/accounts/RoutingNumberFields.tsx:26`, `apps/web/src/routes/accounts/QuotaCeilingFields.tsx:60`, `apps/web/src/routes/pools/PoolFormDialog.tsx:121`, `apps/web/src/routes/keys/KeyFormDialog.tsx:116`.
- **Defect:** `parseInt` reads only the mantissa of valid HTML number-input exponent notation.
- **Failure scenario:** Enter `1e3` as weight or requests and save → browser-valid 1000 becomes 1. Enter `1e6` as a token ceiling → one million becomes 1, yielding a false full-utilization gauge. A pool priority of `1e3` can unexpectedly jump ahead of priority 10.
- **Evidence:** Installed headless Chrome accepted `<input type=number min=1 max=10000 step=1 value=1e3>` with `checkValidity():true`, `valueAsNumber:1000`; current `numeric("weight","1e3")` returned `{weight:1}`, and `parseCeilings({five_hour:"1e6"})` returned `{five_hour:1}`. Happy-dom incorrectly reports `badInput` for this syntax; it cannot establish browser rejection.
- **Fix:** Parse the entire numeric value with `Number`/`valueAsNumber`, followed by explicit finite/integer/range checks; preserve empty-versus-zero semantics. Use one shared numeric boundary helper where practical. Document accepted number syntax in `docs/idea/04-api-keys-and-access.md` / `docs/idea/05-routing-and-failover.md` as appropriate.
- **Test:** Failure first: `1e3` becomes 1000 for account weight, pool weight/priority and key limit; `1e6` becomes one million for ceilings. Fractional, out-of-range and non-finite values reject. Retain a real-browser check for native validity because the DOM test shim differs here.

### 12.6 medium — Equal-base overrides for tiered models are discarded

- **Where:** `apps/web/src/lib/api/settings.ts:133`, `apps/web/src/lib/api/settings.ts:188`, `apps/web/src/lib/api/settings.ts:207`.
- **Defect:** Overrides equal to a model's base rates are classified as shipped and omitted, even when that flat override intentionally disables its higher long-context tier.
- **Failure scenario:** A tiered model has base input price $1 and long-context input $2; operator's valid flat override is $1 for all prompts → console labels it shipped and proposes removing it, re-enabling $2 long-context estimation on save. Creating that flat override through the UI is likewise impossible by entering the base rates.
- **Evidence:** Pure `mergePriceRows` with the two shipped tiers and the flat base-equal override produced `origin:"shipped"`; `buildPriceOverridePayload` returned `[]`. `apps/api/src/services/cost/book.ts:97` returns an override before consulting the tiered shipped lookup, so removing it changes behavior.
- **Fix:** Preserve explicit override intent; equality of four base rates is insufficient when fallback has tier behavior. Give Reset to shipped an explicit remove operation so a flat base-equal override and no override remain representable. Coordinate documentation with cost owner in `docs/idea/08-observability.md`.
- **Test:** Failure first in `apps/web/test/unit/settings.test.ts`: existing base-equal override survives round-trip for a tiered model; creating one yields an override payload; explicit reset removes it. Assert behavior for ordinary untiered rows remains intentional.

## Steps

1. Add failure-first regressions for limit removal and numeric conversion; implement shared full-value validation.
2. Coordinate positive OAuth completion evidence with API owner; fix sequence closing and delayed-start retirement together.
3. Stabilize price editor DOM identity, then preserve flat override intent through all editor transformations.
4. Update the named spec sections in coordination with owning API/cost slices; avoid competing edits to those files.

## Tests

- Audit run shared with slice 11: **747 passed, 0 failed, 58 files** across core/env/web unit suites with DATABASE_URL explicitly blank, Bun 1.4.0.
- Additional audit evidence: inline mounted Solid/QueryClient reproductions for 12.1–12.4, pure pricing/numeric reproductions for 12.5–12.6, installed headless Chrome for exponent input validity. Fetch stubs reject unexpected destinations; no live provider or production DB used.
- Executor: `bin/test apps/web/test/unit/KeyFormDialog.test.tsx apps/web/test/unit/AccountConnect.test.tsx apps/web/test/unit/PoolFormDialog.test.tsx apps/web/test/unit/AccountEditDialog.test.tsx apps/web/test/unit/quota-ceilings.test.ts apps/web/test/unit/settings.test.ts` plus newly added sequence/price editor regressions; then `bin/test apps/web/test/unit` and `bunx biome check <changed files>`.
- Coordinator runs `bin/lint (includes typecheck)` and full `bin/check` once. No per-slice build or DB mutation required.

## Documentation claims falsified

- `KeyFormDialog.tsx:110`: both halves or neither; current submission treats one half as neither.
- `ReconnectSequence.tsx:50`: resetting on close prevents an unintended start; current update order causes one on the first account.
- `docs/idea/08-observability.md:94`: flat overrides replace both tiers; the console cannot preserve one equal to the base card.
- `docs/idea/03-providers.md` describes authorization completion and cancellation; generic metadata updates and stopping a sequence do not reliably produce those outcomes in the console.

## Prior work and not covered

- Reviewed recent web history including #94, #93, #79 and closed audit #57. Existing refetch/auto-begin regression passes; 12.3 concerns close ordering, a different path. Did not re-report the closed live-region, wrapping, empty-result-style or dead fallback findings.
- Read SPA shell/auth transport, query hooks, CRUD/connect forms, usage/price helpers and settings editing. Existing test suite covers quota/status/usage tables. This was not a complete visual/accessibility pass across all viewport/browser combinations.
- No authenticated production UI session, real OAuth login, real Test now, provider request, price write, key edit or account mutation. Responsive styles and provider-specific client cookbook claims were not externally re-verified.
- Browser numeric validation checked locally in Chrome; focus/connect observations came from real Solid rendering under the repository's happy-dom harness, not an end-to-end deployed browser.

## Done when

- A partial limit never mints/removes a throttle; saved numeric values equal valid values shown to operators.
- Only the matching successful login completes a connect dialog; ending a sequence cannot create another login.
- Prices can be edited continuously without losing focus; flat overrides retain their intended tier behavior.
