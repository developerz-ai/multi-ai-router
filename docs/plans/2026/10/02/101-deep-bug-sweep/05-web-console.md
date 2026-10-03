# 05 — Operator console

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/web/`.

Static read of `apps/web/src` against `apps/api/src/routes/admin/*` + their service schemas/views. Live-status overlay (`services/accounts/availability.ts`) and the persistence rule in `services/dataplane/status-writer.ts` (only `exhausted` / `needs_reauth` are written to `accounts.status`; `cooling_down` never is) are what drive 05.1 and 05.2.

## Findings

Ranked most severe first; ids are stable, so they are not in order.

### 05.1 medium — Pools screen counts rate-limited and window-spent members as routable
- **Where:** `apps/web/src/routes/PoolsRoute.tsx:81`, `:95`, `:211-212`; data from `apps/api/src/services/pools/view.ts:64`
- **Defect:** pool member `status` is the stored DB column (never `cooling_down`, no quota windows), and `routableCount` uses `isRoutable` (status only) instead of `isRoutableNow`.
- **Failure scenario:** pool of 3 Claude subs, all live `cooling_down` (or `active` with a spent five-hour window). Accounts and Overview screens show them blocked; Pools screen shows three green dots and "Routable 3 / 3". Operator concludes the pool is healthy while every request 429s.
- **Fix:** in `PoolsRoute.tsx`, join `pool.members` by `accountId` onto `useAllAccounts()` (already polled, already overlaid) and render the joined account's `status`; compute `routableCount` with `isRoutableNow(status, availability?.quotaWindows)` (`lib/account-status.ts`). Fall back to member status only when the account row is missing. (API-side alternative — overlay pool views — belongs to area 1/2.)
- **Test:** unit (`test/unit/` new `PoolsRoute.test.tsx`): pool member stored `active`, accounts list says `cooling_down` → dot is warn, routable `0 / 1`. Second case: `active` + window `spent: true` → `0 / 1`.
- **Overlap:** the root cause, `cooling_down` never being persisted and the list filtering on the stored status, is the same one as slice 02's **02.9**. This finding keeps only the UI fix; 02.9 owns the fix to the status source. If 02.9 lands first, this UI fix stays correct and becomes belt-and-braces.

### 05.2 medium — Accounts status filter filters stored status while rows show live status
- **Where:** `apps/web/src/routes/AccountsRoute.tsx:62-67`, `routes/accounts/AccountsFilters.tsx:28-33`; server `packages/db/src/repositories/account-repository.ts:248` (filters the column) then `apps/api/src/services/accounts/availability.ts:176` (overlays live status after filtering)
- **Defect:** `?status=` is applied to `accounts.status` before the live overlay, so the filter and the rendered status disagree.
- **Failure scenario:** two accounts cooling down after a 429. Operator picks "Cooling down" → "No accounts match this filter" (cooldowns are never persisted). Picks "Active" → both rows appear, each rendered "Cooling down". Same lag for a freshly formed `exhausted` not yet written through.
- **Fix:** drop `status` from the server query in `AccountsRoute.tsx:62-65`; keep `provider` server-side; filter `accountList()` client-side on the overlaid `account.status` before `groupAccountsByProvider`. Keep the empty-state wording keyed on the filter.
- **Test:** unit: rows `[{status:"cooling_down"}, {status:"active"}]` returned for an unfiltered list; selecting "Cooling down" renders exactly the first row; "Active" renders only the second.
- **Overlap:** the root cause, `cooling_down` never being persisted and the list filtering on the stored status, is the same one as slice 02's **02.9**. This finding keeps only the UI fix; 02.9 owns the fix to the status source. If 02.9 lands first, this UI fix stays correct and becomes belt-and-braces.

### 05.10 medium — Lifetime usage chart plots 1970-01-01 … 1971-02-04 and is always empty
- **Where:** UI `apps/web/src/lib/api/usage.ts:31` (offers `lifetime`), `routes/UsageRoute.tsx:225`, `routes/usage/UsageChart.tsx:33-41`. Root cause in the API: `apps/api/src/services/usage-read/window.ts:64` (`from: new Date(0)`) and `axis.ts:21`, `:29`. The 400-point cap keeps the *earliest* points.
- **Defect:** The lifetime axis starts at the epoch and is capped at 400 day-buckets from the start, so every real bucket falls off the axis and `densify` (`axis.ts:45-50`) maps it to nothing.
- **Failure scenario:** The operator picks "Lifetime" on Usage. The chart says "No traffic in this window — the lines would all sit on zero", with ticks Jan 1 1970 → Feb 4 1971. The totals tiles above it show real numbers. The breakdown sparklines on the same axis are flat too. A probe (`buildAxis(resolveWindow({window:"lifetime"}, 2026-10-02))`) returned 400 points, `1970-01-01T00:00:00.000Z` … `1971-02-04T00:00:00.000Z`.
- **Fix:** The API side belongs to area 2. Cap from the *end*: build the axis backwards from `truncate(to)`, or clamp `from` to `to − MAX_POINTS·step`, or to the oldest surviving row. The existing test `apps/api/test/unit/usage/axis.test.ts:30` only asserts the length. UI side: until the API is fixed, `UsageChart` should render "Chart not available for this window" when `points[last].at` is more than one bucket before `data.to`, rather than the misleading "No traffic".
- **Test:** API unit test: a lifetime axis's last point equals `startOfUtcDay(now)` and its first point is no more than 400 days earlier. Web unit test: `UsageChart` given an axis ending a year before `to` does not render the "No traffic" copy.

### 05.3 medium — Half-filled key rate limit silently becomes "no ceiling"
- **Where:** `apps/web/src/routes/keys/KeyFormDialog.tsx:115-120`, `:136`, `:209-228`
- **Defect:** `rateLimit()` returns `null` when either half is empty/unparseable, and `null` means "no ceiling" on mint and "remove the ceiling" on edit — no blocker, no error.
- **Failure scenario:** mint with Requests=60, Per(seconds) empty → key minted unlimited, dialog closes as success. Edit a key with `60/60s`, clear the seconds box to retype, press Save → PATCH `rateLimit: null`, the per-key ceiling is deleted.
- **Fix:** extend `blocker()` (`:122-126`) to return "Set both requests and window, or empty both" when exactly one box is non-empty; disable submit path the same way scope does. Only both-empty maps to `null`.
- **Test:** `test/unit/KeyFormDialog.test.tsx`: requests="60", window="" → submit does not call `onSubmit`, blocker text shown; both empty → `rateLimit: null`; both set → object.

### 05.4 medium — Redirect connect declares "Connected" on any row change, seeded from a possibly stale cache
- **Where:** `apps/web/src/routes/accounts/AccountConnect.tsx:81`, `:104-119`; `lib/queries/accounts.ts:206-216`
- **Defect:** success = `row.updatedAt !== startedAt`, where `startedAt` is `watched.data?.updatedAt` — a disabled query whose cached row is not refetched by invalidation — or the click-time `props.account` snapshot; any unrelated write also flips it.
- **Failure scenario:** (a) ChatGPT/Codex account: redirect-connect it once (watched cache = T1). Edit its label (row → T2; watched query disabled, keeps T1). Press Reconnect → `startedAt = T1` → first 3 s poll returns T2 → "Connected" before the operator authorized anything. (b) During a pending redirect, the refresher or `status-writer` writes `needs_reauth` (bumps `updatedAt`, `account-repository.ts:215`) → dialog reports a successful connect on a row that just went `needs_reauth`.
- **Fix:** in `beginLogin` capture the baseline from a fresh `getAccount` (or `client.fetchQuery` on the detail key) after `begin` succeeds, not from cache; require a connect-specific signal in the effect: `hasCredential`/`credential.present` true AND `status !== "needs_reauth"` AND (`tokenExpiresAt` or `updatedAt`) moved. Better: a server-side pending-login status endpoint (area 1/3) — note only.
- **Test:** `test/unit/AccountConnect.test.tsx`: seed detail cache with T1, account prop T2, start redirect → poll returns T2 → not completed. Poll returns T3 with `status:"needs_reauth"` → not completed.

### 05.5 medium — Account row actions fail silently; a failed Test keeps showing the last success
- **Where:** `apps/web/src/routes/AccountsRoute.tsx:222-229` (disable / enable via shared `update` / per-account recheck / test), `routes/accounts/AccountsNotices.tsx:22-43` (only recheckAll + discover surfaced), `routes/OverviewRoute.tsx:152` (Re-check all, no error render), `routes/accounts/AccountTestNow.tsx:76-98`
- **Defect:** `disable.error`, `update.error` from Enable, `recheck.error`, `test.error` and Overview's `recheckAll.error` are rendered nowhere.
- **Failure scenario:** Test now with a model the upstream rejects as a request error (4xx from the admin route, e.g. unknown account / validation) or a 5xx → spinner stops, cell still reads the previous "Answered · 10:02". Disable hitting a 409/500 → button returns, row unchanged, no message. Operator believes the action happened.
- **Fix:** add `disable`, `update` (only when not editing), `recheck`, `test` outcomes to `AccountsNotices` as danger banners with `errorMessage(...)`; in `AccountTestNow` show `Failed to run: <message>` when the latest mutation for this id errored (pass `test.isError && test.variables?.id === accountId`). Add the same banner on Overview for `recheckAll.isError`.
- **Test:** unit: mock `request` to reject for `/accounts/:id/disable` → banner text contains server message; test mutation rejects → row shows failure, not the cached "Answered".

### 05.11 low — 7d/30d charts draw partial edge buckets as whole days, so both ends always dip
- **Where:** API `apps/api/src/services/usage-read/window.ts:58-60` (`from = now − 7d`, not day-aligned) and `axis.ts:25-31` (truncates `from` down to UTC midnight and includes the current day). UI `routes/usage/UsageChart.tsx:33-35` and `lib/usage-chart.ts:140-156`.
- **Defect:** The 7d axis has **8** day points, and the first and last are partial: the first counts only rows at or after `now − 7d`, and the last counts today so far. The chart labels and scales them as full days.
- **Failure scenario:** At 12:00Z on 2026-10-02 the 7d axis runs 2026-09-25 … 2026-10-02 (probe confirmed). Steady traffic draws as a ramp up from a half-day bucket on the left and a drop on the right, every time. "7 days" shows 8 ticks' worth of buckets. In a negative-offset zone, 05.6 additionally labels each tick one day early.
- **Fix:** API (area 2): align named day-windows to whole UTC days (`from = startOfUtcDay(now) − (N−1)d`), or mark edge buckets as partial in the payload. UI: render a partial edge bucket dashed or muted when it starts before `data.from` or ends after `data.to`, and say "last 7 days (UTC days)" in the window note.
- **Test:** API axis test: the 7d axis has 7 points starting at `startOfUtcDay(now) − 6d`. Web test: an edge bucket flagged partial gets the muted class.

### 05.6 low — UTC buckets rendered as local dates; "Today" is the UTC day but labelled as local
- **Where:** `apps/web/src/routes/usage/UsageChart.tsx:35`, `lib/format.ts:58-63`; server `apps/api/src/services/usage-read/window.ts:56`, `axis.ts:24-30` (UTC-midnight buckets)
- **Defect:** day-bucket `at` is UTC midnight; `formatDate` renders it in the viewer zone; "Today" tiles/buttons never say UTC.
- **Failure scenario:** operator in `America/Los_Angeles`: bucket `2026-10-01T00:00:00Z` ticks as "Sep 30, 2026" (verified with `TZ=America/Los_Angeles`), so every day label is one day early; at 18:00 PDT "Today" shows only 2 h of traffic.
- **Fix:** format day ticks with `timeZone: "UTC"` (add a `formatUtcDate` in `lib/format.ts`, use it in `UsageChart.tsx:35` for `bucket === "day"`); label the window "Today (UTC)" in `lib/api/usage.ts` `usageWindowLabel`, matching `docs/idea/08-observability.md:154`.
- **Test:** `test/unit/format.test.ts`: `formatUtcDate("2026-10-01T00:00:00Z")` contains "Oct 1" under `TZ=America/Los_Angeles`.
- **Custom ranges (second dive):** `routes/UsageRoute.tsx:72-87` with `lib/datetime-input.ts:33-37` converts the operator's local wall time to the correct instant; that part is right. But a range longer than 2 days gets UTC-midnight day buckets (`window.ts:41-48`, `axis.ts:52-55`). A Berlin operator who asks for "Oct 1 00:00 → Oct 4 00:00" local gets a first bucket labelled `Sep 30` (UTC 22:00 the night before, so it is mostly outside the range) and an extra partial bucket on the right. The local days they asked about never line up with a bar. The fix is the same `formatUtcDate`, plus a "buckets are UTC days" caption on the custom-range form. Partial edges are covered in 05.11.
- **DST:** none of this changes at a DST switch, because the buckets are UTC days and hourly ticks use `formatTime` in the viewer's zone. That was checked and is not a separate defect.

### 05.13 low — A destructive confirm can be dismissed while its request is in flight, and the outcome is lost
- **Where:** `apps/web/src/components/Modal.tsx:45-49` and `:57` (Escape and scrim always call `onClose`). `components/ConfirmDialog.tsx:228`, where Cancel is not disabled while `busy`. Consumers reset the mutation on close: `routes/KeysRoute.tsx:233-236` and `:252-255` (`revoke.reset()` / `remove.reset()`). The same pattern is used for account delete (`routes/accounts/AccountDeleteDialog.tsx:29`) and pools (`routes/PoolsRoute.tsx:194`).
- **Defect:** Closing during `busy` calls `mutation.reset()` on a pending mutation. TanStack drops the observer, so the per-call `onSuccess` and the error never render.
- **Failure scenario:** The operator confirms "Delete account" and presses Escape a beat later. The server answers `409` naming the keys whose scope it would narrow (the sentence `ConfirmDialog` exists to show, `ConfirmDialog.tsx:211-220`). The dialog is already gone and nothing is shown. The row is still there after the refetch, with no explanation.
- **Fix:** In `Modal`, add a `dismissible` prop, `false` while busy. `createFocusTrap`'s `onEscape` and the scrim then no-op, and `ConfirmDialog` passes `dismissible={!busy}` and disables Cancel while busy.
- **Test:** Unit test: render `ConfirmDialog busy`, dispatch Escape, and assert `onClose` was not called.

### 05.14 low — Focus falls to `<body>` after confirming a delete
- **Where:** `apps/web/src/lib/focus-trap.ts:49-50` and `:80-84` (restores to the element focused at open time). Callers: `routes/accounts/AccountDeleteDialog.tsx`, `routes/KeysRoute.tsx:256`, `routes/PoolsRoute.tsx:194`.
- **Defect:** The restore target is the row's Delete button. A successful delete invalidates and refetches, which removes that row, so `restore.focus()` on a detached node does nothing.
- **Failure scenario:** A keyboard or screen-reader operator deletes key 3 of 10. Focus lands on `<body>`, and the next Tab starts again from the skip link at the top of the page. "Keyboard reachable, focus-visible everywhere" (CLAUDE.md Frontend) is broken on the most common destructive path.
- **Fix:** In the trap cleanup, if `restore?.isConnected` is false, fall back to a caller-supplied `fallbackFocus` (the table, the page heading with `tabindex="-1"`, or the next row's action). Expose that through `ModalProps` and `ConfirmDialog`.
- **Test:** Unit test: open a trap from a button, remove the button, deactivate the trap, and assert `document.activeElement` is the fallback rather than `body`.

### 05.12 low — "On cooldown — next check 5m ago" stays after the cooldown has passed
- **Where:** `apps/web/src/routes/accounts/AccountRecheck.tsx:73-87` and `routes/accounts/AccountTestNow.tsx:80-86`. The cache is `lib/queries/accounts.ts:168-173` and `:187-194` (`staleTime: Infinity`, never refetched).
- **Defect:** The press verdict `rechecked:false` / `tested:false` is cached for good. Its `nextAllowedAt` is rendered relative to the ticking clock, with no check that it is already past.
- **Failure scenario:** The operator presses Re-check inside the server's `ACCOUNT_RECHECK_COOLDOWN_SECONDS` (default 60 s), and the cell reads "On cooldown — next check in 40s". Ten minutes later it reads "On cooldown — next check 9m ago" (`formatRelative` past branch, `lib/format.ts:88`). The cell contradicts itself and suggests the button is still blocked.
- **Fix:** When `Date.parse(nextAllowedAt) <= nowMs`, render "Ready to re-check" / "Ready to test" (or nothing). Keep reading the instant from the server: these intervals are rightly not hard-coded in the client.
- **Test:** Unit test: a cached result with `rechecked:false` and `nextAllowedAt` one minute in the past renders no "On cooldown".

### 05.7 low — Any edit of an expired key is refused
- **Where:** `apps/web/src/routes/keys/KeyFormDialog.tsx:83`, `:137`; `apps/api/src/services/keys/service.ts:153`, `:257-260`
- **Defect:** the edit form always re-sends the stored `expiresAt`; the API rejects a past instant on update.
- **Failure scenario:** key expired yesterday; operator opens Edit to rename it or narrow its scope, leaves expiry untouched → `400 expiry_in_past`. Only workaround is changing an unrelated field.
- **Fix:** in `KeysRoute.tsx:137` (or the dialog) omit `expiresAt` from the PATCH when it equals the seeded value (`toDateTimeInput(key.expiresAt)` unchanged); send it only when the operator edited the box.
- **Test:** `test/unit/KeyFormDialog.test.tsx`: key with past `expiresAt`, change name only → submitted values lack `expiresAt` (or route-level patch lacks it).

### 05.8 low — Re-check cell prefers this tab's old press over the server's newer timestamp
- **Where:** `apps/web/src/routes/accounts/AccountRecheck.tsx:39-41`, `:77-90`; `lib/queries/accounts.ts:187-194` (`staleTime: Infinity`)
- **Defect:** `checkedAt = result()?.lastCheckedAt ?? props.lastCheckedAt` — the cached press result never yields to a later server reading, and "Eligible again" persists until reload.
- **Failure scenario:** press Re-check at 10:00; another operator (or tab) re-checks at 10:30 and the account has since failed again → this tab still shows "Checked 10:00 … Eligible again — status updates on the next request".
- **Fix:** take the later of `result().lastCheckedAt` and `props.lastCheckedAt`; render the press verdict only while `result().lastCheckedAt` is that later one.
- **Test:** unit: cached press 10:00, prop 10:30 → renders 10:30 and no "Eligible again".

### 05.9 low (unverified) — Mutations can fire before the CSRF token is adopted
- **Where:** `apps/web/src/layout/AppLayout.tsx:32`, `:166-168`; `lib/api/client.ts:56`
- **Defect:** route children render before `useSession()` resolves; `buildInit` silently omits `x-csrf-token` when the token is null.
- **Failure scenario:** cold load of `/accounts`, operator clicks Disable before `GET /auth/session` returns → request without header → `403 "That is not permitted."` Window is a round trip; not reproduced.
- **Fix:** in `request()` await the in-flight session query (or refuse with a clear ApiError) when `isMutating && csrfToken() === null`; or gate `<main>` on `session.isSuccess`.
- **Test:** `test/unit/api-client.test.ts`: mutating request with null token → does not fetch without header.

## Still open from 2026-07-30 audit

All 10 CONFIRMED-BUG verdicts are **fixed** in current code: HIGH 3/4/5 (pre-mounted `role="status"` in `AccountRecheck.tsx:57`, `AccountTestNow.tsx:76`, `AccountModels.tsx:45`), HIGH 7 (`numeric()` fallback removed, `RoutingNumberFields.tsx`), MEDIUM 1 (`.success:empty`, `ConnectDialog.module.scss:107`), MEDIUM 3 (`AccountsTable.module.scss:9`), MEDIUM 4 (`PageHeader.module.scss` `flex-wrap`), MEDIUM 6 (`PriceAddForm.tsx:46,53` `required`), MEDIUM 7/LOW 10 (Sparkline accent rule gone), LOW 5 (`PoolsRoute.module.scss` `.member > span:not([class])`).

Unchanged, all previously judged TRUE-BUT-NOT-A-BUG (no action unless premise changes): HIGH 1 / MEDIUM 2 safe-area (still no `viewport-fit=cover` in `index.html:5`), HIGH 6 `aria-live` on ThemeToggle button (`ThemeToggle.tsx:30`), MEDIUM 8 `filter: brightness` (`Button.module.scss:51`), LOW 1/2 overflow on `.version` / `.provider`, LOW 6 `aria-busy="false"` (`StatTile.tsx:19`), LOW 7 no `maxlength` on paste textarea, LOW 8 no `autocomplete="off"` on Test-now model field, LOW 11 hard-coded favicon stroke, LOW 12 mono `.figure`. LOW 3 now has wrap (`TaskHealthSection.module.scss:44`).

## Steps
1. 05.1 + 05.2: consume overlaid account statuses client-side (Pools join; Accounts client-side status filter). One PR, `apps/web/src/routes/PoolsRoute.tsx`, `routes/AccountsRoute.tsx`.
2. 05.3 + 05.7: KeyFormDialog half-filled blocker; omit unchanged `expiresAt` on edit.
3. 05.4: rework redirect-completion detection in `AccountConnect.tsx`.
4. 05.5: surface every row-action mutation error (`AccountsNotices.tsx`, `AccountTestNow.tsx`, `OverviewRoute.tsx`).
5. 05.6, 05.8, 05.9: format/labels, recheck timestamp precedence, CSRF gate.
6. 05.10 + 05.11: the axis fix lives in the API (`usage-read/window.ts`, `axis.ts`, area 2). UI guard in `UsageChart.tsx` against an axis that does not reach `to`, plus muted partial edge buckets.
7. 05.12: hide a cooldown verdict whose `nextAllowedAt` has passed (`AccountRecheck.tsx`, `AccountTestNow.tsx`).
8. 05.13 + 05.14: a non-dismissible modal while busy, and a fallback focus target (`components/Modal.tsx`, `components/ConfirmDialog.tsx`, `lib/focus-trap.ts`).

## Tests
- New/extended unit tests under `apps/web/test/unit/`: `PoolsRoute.test.tsx` (new), `AccountsTable.test.tsx`/new `AccountsRoute` filter test, `KeyFormDialog.test.tsx`, `AccountConnect.test.tsx`, `mutation-invalidation.test.tsx` (error surfacing), `format.test.ts`, `api-client.test.ts`.
- New tests from the second dive: `UsageChart.test.tsx` (05.10/05.11), `ConfirmDialog.test.tsx` (05.13), `focus-trap.test.ts` (05.14), and recheck/test-now cooldown expiry (05.12). Area 2 tests on the API side: `apps/api/test/unit/usage/axis.test.ts` asserts that the lifetime and 7d axes end at today and have the right length.
- Each written failing first against current code, per finding's **Test** line.

## Done when
- Pools "Routable" and dots agree with Accounts/Overview for cooling and window-spent members.
- "Cooling down" filter lists exactly the rows rendered "Cooling down".
- No key form submit can drop or remove a ceiling from a half-filled pair.
- Redirect connect never reports success without a credential change on a non-`needs_reauth` row.
- Every account row action failure is visible with the server's message.
- The lifetime chart plots the most recent days. The 7d chart shows 7 whole UTC days, and its edges are marked when partial.
- No cell says "On cooldown" once the cooldown has passed.
- A busy destructive dialog cannot be dismissed. After a delete, focus lands on a defined element, never `<body>`.
- `bin/check` green.

## Falsified doc claims
- `apps/web/src/routes/accounts/AccountConnect.tsx:39-43` comment: "the login is declared complete when the row changes underneath it … comparison against `updatedAt` captured at the start" — the capture can be a stale cached `updatedAt`, and unrelated writes (status writer, refresher) also change it (05.4).
- `apps/web/src/lib/queries/accounts.ts:26-30` implies pool views carry account *status* worth invalidating for — they carry the stored status, not the live one the console shows elsewhere (05.1).
- `docs/idea/08-observability.md:154` says "today (current UTC day)" — console never tells the operator it is UTC (05.6).
- The `apps/api/src/services/usage-read/axis.ts:20` comment says the cap "guards a `lifetime` window from asking for tens of thousands of points". The cap keeps the *oldest* 400 points, so a lifetime chart is 1970–1971 (05.10).
- The `apps/web/src/components/Modal.tsx:31-34` comment says "focus containment and Escape are implemented once rather than approximated per caller". Escape ignores `busy`, and focus restore ignores a trigger that has been removed (05.13, 05.14).

## Not covered
- No live browser run, so screen readers and responsive layout were not exercised. Modal and focus behaviour was traced statically (`components/Modal.tsx`, `lib/focus-trap.ts`, every `ConfirmDialog`/`Modal` caller). No dialog nests another, so traps never stack, and the form → connect hand-off (`routes/AccountsRoute.tsx:250-258`) restores and re-captures focus in the right order.
- Polling, checked in the second dive: the fleet poll (`LIVE_POLL_MS` 20 s, `lib/query.ts:15`), the live feed (10 s, `lib/queries/usage-recent.ts:20`), task health (30 s, `lib/queries/settings.ts:33`) and the redirect watch (3 s, `routes/accounts/AccountConnect.tsx:28`) are client constants with no server counterpart. Every server-configured interval the console shows is read from the response, never duplicated: re-check and test-now `nextAllowedAt`, login `expiresAt`, task `intervalMinutes`. No mismatch was found beyond 05.12. The login-expiry warn and danger thresholds (`lib/subscription-login.ts:17-19`, 7 d / 2 d) are client-only display constants with no server equivalent, which is acceptable as presentation. The usage summary never polls, refetching only on focus by design (`lib/query.ts:11-13`).
- `UsageTopN`, `UsageBreakdown`, `RecentAttemptsTable`, `OnboardingPanel`, `client-snippets.ts`, `KeyConnectSnippets.tsx` and `RetentionSection.tsx` were only skimmed.
- Cross-area: API `GET /accounts?status=` filters before the live overlay, and `PoolMemberView.status` is the stored value only. Both are the server-side roots of 05.1/05.2 and are owned by **02.9**. A server-side "pending login landed" signal for 05.4 belongs to area 1/3. The axis and window fixes for 05.10/05.11 (`usage-read/axis.ts`, `window.ts`) belong to area 2.
