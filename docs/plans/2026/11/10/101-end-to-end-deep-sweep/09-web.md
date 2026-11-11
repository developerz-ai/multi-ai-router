# 09 — Web (operator console)

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `apps/web/` (src, test, `vite.config.ts`, `ui-geometry/`).

Static read of all non-test TS/TSX under `apps/web/src` + three throwaway probes run under the repo's own happy-dom/Solid harness (scratch dir, not committed) for 09.1 / 09.3. No NN violation found in this area. SCSS swept by grep only (see Not covered).

## Findings

### 09.1 high — Every refetch tears down and rebuilds the whole screen; local UI state dies on each 20 s / 10 s poll
- **Kind:** bug + perf
- **Where:** `apps/web/src/components/QueryBoundary.tsx:39`, `apps/web/src/components/Table.tsx:81`, `apps/web/src/lib/query.ts:21-33` (no `reconcile`), polls at `apps/web/src/lib/queries/accounts.ts:38-52`, `queries/pools.ts:24-31`, `queries/usage-recent.ts:20-31`, `queries/settings.ts:30-36`. Upstream cause: `@tanstack/solid-query` 5.104 `useBaseQuery.ts:153` forces `structuralSharing = false`, and `reconcile` defaults to `false`.
- **Defect:** with both off, every observer result carries brand-new object identities even for a byte-identical response; `QueryBoundary` passes `props.query.data` by value inside a `<Match>` child, so its render callback is re-invoked and the entire subtree is disposed and recreated; `<Table>`'s reference-keyed `<For>` then has nothing to keep either.
- **Failure scenario:** probe mounting the real `AccountsRoute` against a stubbed fetch: collapse a provider group, type `claude-x` into a row's Test-now model box, run `refetchQueries(["accounts"])` with an identical body (what `LIVE_POLL_MS` does) → `aria-expanded` back to `true`, input `""`, row `<tr>` and toggle are different nodes. So on `/accounts` every 20 s: collapsed groups re-open (`ProviderGroup.tsx:30`), a half-typed model is wiped and the in-row "Test this Claude subscription now?" confirm vanishes (`AccountTestNow.tsx:44-45`, `:104`), keyboard focus drops to `<body>`, table scroll position resets, pre-mounted `role="status"` regions are remounted. Same on `/usage` (feed: up to 200 rows × 8 cells rebuilt every 10 s; `UsageTopN` "Rank by" resets on any summary refetch), `/pools`, `/keys` and Settings (task table every 30 s; price inputs lose focus on window refocus). Cost per poll on `/accounts`: N rows × 12 cells + 2 `QueryObserver`s per row (`useLastRecheck`, `useLastTest`) created and destroyed.
- **Fix:** (1) `query.ts`: add `reconcile: "id"` to `defaultOptions.queries` (probe with it set: same scenario keeps expanded=false, input kept, same nodes); set a per-query key where rows have no `id` — tasks (`task`), weekly reports (`periodStart`). (2) `QueryBoundary`: stop passing data by value — render children once and hand them an accessor (`children: (data: Accessor<T>) => JSX.Element`), update the ~10 call sites; this is what makes the boundary robust regardless of (1). (3) `Table`: key rows by `rowId` (map over ids, look the row up through an accessor) so a replaced row object updates in place. Check every `cell:` that returns a plain string still re-reads its fields — `Table.tsx:87` evaluates `column.cell(row)` inside a tracked insert, so it does; keep that. No `docs/idea/` behaviour change.
- **Test:** `apps/web/test/unit/refetch-identity.test.tsx` (new), failure first: mount `AccountsRoute`, collapse group + type model, identical refetch → both survive and `tr[data-row-id]` is the same node; changed `lastUsedAt` on one row → that row's text updates, sibling row node unchanged. Same shape for `UsageRecent` (row node identity across a poll).

### 09.2 medium — No error boundary anywhere: a stale tab after a release goes blank on the next navigation
- **Kind:** bug (reasoned, not reproduced)
- **Where:** `apps/web/src/lib/routes.ts:51-99` (every screen `lazy()`), `apps/web/src/App.tsx:8-25`, `apps/web/src/layout/AppLayout.tsx:167-169` (bare `{props.children}`); no `ErrorBoundary` in `src/` (grep). Server side: `apps/api/src/routes/spa.ts` answers any non-file path with `index.html`.
- **Defect:** a rejected lazy import or any render-time throw is uncaught; nothing renders in its place and nothing tells the operator to reload.
- **Failure scenario:** console left open on Overview (the stated use: second monitor); router upgraded (several releases a day). Operator clicks Usage → old tab imports `assets/UsageRoute-<oldhash>.js`, which no longer exists → SPA fallback returns `index.html` as `text/html` → module load fails → `<main>` stays empty forever. Same blank result for any shape drift between an old bundle and a new API, because responses are cast, not validated (`lib/api/client.ts:101`).
- **Fix:** wrap `props.children` in `AppLayout` (and the `/login` route) in `<ErrorBoundary>` rendering `ErrorState` with a "Reload console" action; add a `vite:preloadError` listener in `main.tsx` that reloads once (guard against a loop with a session flag in memory/URL). Cross-slice: area 01 should answer a missing `/assets/*` with `404`, not the document (`spa.ts`).
- **Test:** unit: route component whose lazy thunk rejects → fallback with reload button is rendered, nav still usable. Unit: child that throws during render → same fallback, not an empty `<main>`.

### 09.3 medium — A usage-summary refetch rebuilds every cell of the Accounts and Keys tables
- **Kind:** bug + perf
- **Where:** `apps/web/src/routes/accounts/AccountsTable.tsx:64`, `:135`, `:276`; `apps/web/src/routes/keys/KeysTable.tsx:45`, `:90`, `:106`, `:167`; source of the churn `apps/web/src/lib/queries/table-usage.ts:45-52`, spread at `routes/AccountsRoute.tsx:219` and `routes/KeysRoute.tsx:232`.
- **Defect:** `columns()` is rebuilt whenever anything it reads changes, and the header string reads `props.usageWindowLabel`, which arrives through `{...usage()}` — one memo over the whole usage object — so any change to the summary yields new column objects and `Table`'s inner `<For each={merged.columns}>` recreates every `<td>` in every row.
- **Failure scenario:** `/accounts`, operator typing a model for Test now; usage summary lands (first load arrives after the accounts list; later on window refocus, or after any Test now, which invalidates `usage` — `queries/accounts.ts:138-141`). All cells are recreated: input cleared, focus lost. Probe: changing only the header-driving signal → row `<tr>` kept, cell node replaced. Survives the 09.1 fix. First paint also builds all cells twice.
- **Fix:** build columns once per table (`const columns = [...]`, reading props lazily inside `cell`), with the header taken from a constant — `TABLE_USAGE_WINDOW` never changes (`table-usage.ts:29`), export its label instead of threading it through reactive props. Do the same audit for `PriceTable.tsx:46`, `RecentAttemptsTable.tsx:48`, `UsageBreakdown.tsx:28` (header reads `props.dimension` — acceptable, it is a real column change), `AuditLogSection.tsx:54`, `TaskHealthSection.tsx:38`.
- **Test:** `AccountsTable.test.tsx`: swap the `usage` map prop for a new one → `td` nodes identical, traffic figure updated.

### 09.4 medium — Earlier ledger findings still present in current code (carry-over, not new)
- **Kind:** bug (each line re-read today unless marked)
- **Where / Defect:**
  - 12.1 / 05.3 — `routes/keys/KeyFormDialog.tsx:124-135`: half-filled rate limit is `null` (mint unlimited / edit removes the ceiling); `blocker()` covers scope only.
  - 12.5 — `Number.parseInt` on number inputs: `routes/accounts/RoutingNumberFields.tsx:27`, `routes/accounts/QuotaCeilingFields.tsx:60`, `routes/pools/PoolFormDialog.tsx:121`, `routes/keys/KeyFormDialog.tsx:125-126` (`1e3` saved as `1`).
  - 12.3 — `routes/accounts/ReconnectSequence.tsx:53-56`: `setIndex(0)` before `props.onClose()`; with `AccountConnect.tsx:109-127` this starts a login on account zero when stopping from a later step. Code unchanged since the ledger; not re-run here (`unverified` this pass).
  - 12.4 — `routes/settings/PriceOverridesSection.tsx:57-60` rebuilds every `PriceRow` per keystroke into the reference-keyed `Table` (`unverified` this pass; same mechanism as 09.1, fixed by keying `Table` by `rowId`).
  - 05.2 — `routes/AccountsRoute.tsx:56-61` still sends `status` to the server, which filters the stored column (`packages/db/src/repositories/account-repository.ts:90`) before the live overlay (`apps/api/src/services/accounts/availability.ts:209`): "Cooling down" matches nothing.
  - 05.7 — `KeyFormDialog.tsx:150` + `routes/KeysRoute.tsx:168` always resend `expiresAt`; `apps/api/src/services/keys/mutations.ts:75` rejects a past instant, so an expired key cannot be renamed.
  - 05.13 — `components/Modal.tsx:45-49`, `:57`, `components/ConfirmDialog.tsx:43`: a busy destructive confirm can be dismissed; callers `reset()` the pending mutation and the `409` sentence is lost.
  - 05.14 — `lib/focus-trap.ts:80-84`: focus restored to a node the delete just removed.
  - 05.12 residue — `routes/accounts/AccountTestNow.tsx:83-87`: "On cooldown — next test 9m ago" (the recheck cell was fixed at `AccountRecheck.tsx:76`, this one was not).
  - 05.9 — `layout/AppLayout.tsx:167`, `lib/api/client.ts:61`: a mutation fired before `GET /auth/session` resolves goes out with no CSRF header (`unverified`, as before).
- **Failure scenario:** as recorded in `docs/plans/2026/10/02/101-deep-bug-sweep/05-web-console.md` and `102-full-router-audit/12-web.md` (slice 12 is still marked open in that plan's `status.yml`).
- **Fix:** as recorded there. 12.6 looks addressed (`preserveOverride`, `PriceOverridesSection.tsx:102`) — not re-verified.
- **Test:** the failure-first tests named in those two slices.

### 09.5 low — Upstream credential, admin password and pasted OAuth result outlive their dialogs in the mutation cache
- **Kind:** structure (defence in depth)
- **Where:** `apps/web/src/lib/queries/accounts.ts:54-69` (`useCreateAccount`, `useUpdateAccount` — variables carry `credential`), `queries/session.ts:46-54` (`useLocalLogin` — variable is the password), `queries/connect.ts:47-55` (`useCompleteConnect` — `pasted`); rule stated and applied only at `queries/router-keys.ts:16-31`, `:49`, `:71`.
- **Defect:** the module that explains why a mutation result must not sit in the mutation cache for the default five minutes applies `gcTime: 0` to router keys only; the three mutations whose *variables* are more sensitive keep the default.
- **Failure scenario:** operator adds an account with an API key, dialog closes, `create.reset()` runs → the mutation entry, with `state.variables.credential` in clear, stays reachable from the `QueryClient` for 5 min; the admin password likewise after login navigates away.
- **Fix:** `gcTime: 0` on those four mutations (callers already `reset()` on close; `LoginRoute` unmounts). Add `autocomplete="off"` to the credential `type="password"` fields (`routes/accounts/AccountFormDialog.tsx:197`, the edit dialog's) so a password manager does not offer to store an upstream key against the router's origin.
- **Test:** `mutation-invalidation.test.tsx`: after create + reset, `client.getMutationCache().getAll()` holds no entry whose variables contain the credential.

### 09.6 low — Queries retry `4xx`, and every poll retries a `401` before the redirect
- **Kind:** bug (small)
- **Where:** `apps/web/src/lib/query.ts:28-30`
- **Defect:** `retry: 1` is unconditional, though the comment beside it says retrying a `401` only delays the login redirect; only the session query opts out (`queries/session.ts:16`).
- **Failure scenario:** session expires on an open `/accounts` tab → accounts and pools polls each fail, wait ~1 s, fire again (4 requests, all `401`). A `403`/`404`/`400` on any read shows its error card a second late after a pointless repeat.
- **Fix:** `retry: (count, error) => count < 1 && !(isApiError(error) && error.status < 500)`.
- **Test:** `api-client`-level unit with a stub fetch returning `403`: one call, not two; `502`: two.

### 09.7 low — Request-id search fires one request and one cache entry per keystroke
- **Kind:** perf
- **Where:** `apps/web/src/routes/usage/UsageRecent.tsx:45-50`, `:73-79`; key at `lib/queries/query-keys.ts:76-77`
- **Defect:** the raw input value is part of the query key with no debounce.
- **Failure scenario:** typing a 36-char id → 36 `GET /usage/recent?requestId=<prefix>` (each an indexed lookup that cannot match a prefix), 36 cache entries held for `gcTime`.
- **Fix:** debounce the id into the key (≈300 ms) or apply it on Enter/blur; keep `keepPreviousData`.
- **Test:** `UsageRecent` unit: type 5 characters quickly → one request carrying the final value.

### 09.8 low — The 1 s clock on `/accounts` recomputes far more than countdown text
- **Kind:** perf
- **Where:** `apps/web/src/routes/AccountsRoute.tsx:43`; `components/QuotaWindowRow.tsx:61` (`points={[...window().tokenSeries]}`); `components/ResetIndicator.tsx:52-54`; `routes/accounts/CredentialCell.tsx:45` (`login` is a plain function, read 6× per render).
- **Defect:** each tick rebuilds every window description per row, the array copy hands `Sparkline` a new `points` so its path memo (`Sparkline.tsx:26`) re-runs for every window, and `describeLoginExpiry` runs ~6× per subscription row.
- **Failure scenario:** 50 subscription accounts × 3 windows → 150 path string builds + ~300 login-expiry computations + 150 description objects per second on an idle tab. One shared clock is right; what hangs off it is not.
- **Fix:** pass `window().tokenSeries` by reference (it is already the server array, `lib/quota-windows.ts:296-300`); `createMemo` for `login`; split the static part of a window description (label, gauge, series) from the clock-driven reset text so only the latter reads `nowMs`.
- **Test:** unit: advance `nowMs` on `ResetIndicator` → the `<path d>` setter is not invoked (spy on `toPath` via a counting `points` getter).

### 09.9 low (unverified) — `safeNextPath` lets `/\host` through
- **Kind:** bug
- **Where:** `apps/web/src/lib/routes.ts:44-48`, used at `routes/LoginRoute.tsx:31`, `:38-45`, `:51`
- **Defect:** only a leading `//` is refused; browsers read `/\evil.example` as `//evil.example`.
- **Failure scenario:** `/login?next=/%5Cevil.example`. Local-password door: `navigate()` → `pushState` to a cross-origin URL throws, so a correct password appears to do nothing. SSO door: the value is forwarded to `/api/admin/auth/oidc/start?next=…`; whether the API re-validates it is area 01/02's (cross-slice hint).
- **Fix:** refuse any `next` containing `\`, a control character, or not matching `^/(?!/)`; resolve with `new URL(value, location.origin)` and require same origin.
- **Test:** `routes.test.ts`: `/\\evil.example`, `/\t/evil.example` → `/`.

### 09.10 low — Sign-in page prints the `?error=` query parameter verbatim
- **Kind:** bug (content spoofing; text node, no HTML)
- **Where:** `apps/web/src/routes/LoginRoute.tsx:32-36`, `:63-67`
- **Defect:** any string in `error` is shown inside the login card as an alert.
- **Failure scenario:** link `…/login?error=Session+locked.+Call+IT+on+555…` renders that sentence under the product name on the real origin.
- **Fix:** have the OIDC callback redirect with a short code and map known codes to fixed sentences here; unknown → one generic line (callback side: area 01).
- **Test:** `LoginRoute` unit: unknown `error` value → generic sentence, raw value absent from the DOM.

### 09.11 low — Structure
- **Kind:** structure
- **Where / Defect:**
  - `apps/web/src/lib/quota-windows.ts` 336 LOC, `routes/overview/OnboardingPanel.tsx` 304 LOC (>300 rule).
  - `invalidateAccountReaders` defined twice: `lib/queries/accounts.ts:198-206`, `lib/queries/connect.ts:70-77`.
  - Two spellings of one absolute instant, both on an accounts row: `formatAbsolute` (`lib/reset-countdown.ts:153`, short date) and `formatTimestamp` (`lib/format.ts:50`, medium date).
  - Filter self-heal written twice: effect at `routes/KeysRoute.tsx:101-108` and `liveSelection` at `routes/keys/FilteredKeys.tsx:35-36`; the effect is derived state written from an effect and can go.
  - `lib/api/client.ts:101`: every response is `as T`; no schema at the SPA's one external boundary (CLAUDE.md "Zod at every external boundary"). With 09.2 open, drift is a blank screen rather than an error card.
- **Fix:** split `quota-windows.ts` (description vs series/measured-fraction helpers) and lift the onboarding steps list out of the panel; one shared invalidator; one absolute formatter; drop the effect; validate at least the list reads the tables index into (accounts, keys, pools) with shared Zod schemas from `packages/core`.
- **Test:** existing suites; add a schema-rejects-drift unit per validated read.

## Checked, not a bug
- Polling budget, visible idle tab: Overview/Accounts/Keys/Pools 6 req/min (accounts + pools at 20 s, `lib/query.ts:15`), Usage 9 (feed 10 s + accounts), Settings 2 (tasks 30 s). Hidden tab: none (`refetchIntervalInBackground` default; only the device-code poll opts in, `queries/connect.ts:109`, deliberate).
- No client N+1: per-row usage/sparkline cells read one shared `["usage","summary","7d"]` entry (`queries/table-usage.ts:40-52`); quota windows ride the accounts list.
- One shared clock per screen (`lib/clock.ts:13-18`, cleaned up), no per-row timers; `CopyValue` timeout, focus-trap listener, media-query listener all have `onCleanup`.
- Route-level code splitting present (`lib/routes.ts`); no icon or chart library (inline SVG); deps are solid, router, query only.
- CSRF: all mutations go through `request()` (`lib/api/client.ts:58-61`); CSV export and OIDC start are GETs. Token and username in memory only; `localStorage` holds the theme only (`lib/theme-dom.ts`).
- No `innerHTML`; upstream error strings are text nodes. No "shown once" wording — the only hits state the opposite (`routes/keys/KeyValueDialog.tsx:53-56`, `routes/KeysRoute.tsx:181`). Reveal/mint values kept out of the cache (`queries/router-keys.ts`).
- Spec conformance verified: `exhausted` → "Needs top-up — no reset", never a countdown (`lib/reset-countdown.ts:98-108`), red Overview banner (`routes/OverviewRoute.tsx:192-214`); reset shown absolute + countdown per window with reported/estimated/unknown (`components/ResetIndicator.tsx`, `QuotaWindowRow.tsx:66-87`); Re-check per row and all-accounts; destructive actions list consequences (`routes/accounts/account-cells.ts:97-136`, `routes/keys/KeyDangerDialogs.tsx:63-77`, `routes/PoolsRoute.tsx:233-239`); usage windows today/7d/30d/lifetime + custom.
- Many accounts per provider: grouping by provider is presentation only (`lib/account-groups.ts:63-77`); nothing dedupes or keys state by provider alone.
- Query keys carry every parameter (`lib/queries/query-keys.ts`); custom ranges and sorted filter lists are in the usage key; cache-only `recheck`/`test`/`models` keys sit under `["accounts"]` but are `enabled: false`, so root invalidation does not refetch them.
- No raw hex/rgb in component SCSS (grep; only `styles/_tokens.scss`); no `outline: none`; `prefers-reduced-motion` handled in `styles/reset.scss` and per component.
- No `any`, `console.*`, `@ts-ignore` in `src/`.
- `build.sourcemap: true` (`vite.config.ts:46`): maps of an open-source SPA; no secret is compiled in.
- Session loss does not clear the query cache (`layout/AppLayout.tsx:48-52`); single admin, so no cross-identity exposure.

## Doc claims falsified
- `apps/web/src/routes/usage/UsageQuota.tsx:86-87` ("`Index`, not `For` … keying by reference would dispose and recreate every gauge"): the enclosing `For` over accounts and the whole boundary above it are recreated on every accounts poll (09.1).
- `apps/web/src/routes/accounts/AccountRecheck.tsx:40-42`, `AccountTestNow.tsx:75-77` ("pre-mounted live region"): the region is remounted with its text on every poll (09.1).
- `apps/web/src/lib/query.ts:28-30` ("retrying it only delays the redirect … Retry once, for genuine transport blips"): the setting retries `401` and every other `4xx` too (09.6).
- `apps/web/src/lib/queries/router-keys.ts:16-31` (credential-bearing mutations "do not leave it lying around"): true for router keys only (09.5).
- `apps/web/src/routes/keys/KeyFormDialog.tsx:246` hint "Both halves or neither": one half is accepted and means "neither" (09.4).

## Steps
1. 09.1: `reconcile` default in `lib/query.ts`; `QueryBoundary` accessor signature + call sites; `Table` keyed by `rowId`. One commit, with `refetch-identity.test.tsx` first.
2. 09.3: static column definitions in `AccountsTable`, `KeysTable`; constant usage-window header.
3. 09.2: `ErrorBoundary` in `AppLayout`/login route, `vite:preloadError` reload; hand the `/assets/*` 404 to area 01.
4. 09.4: land the carried-over fixes in the groups the earlier slices named (key form + numeric parsing; reconnect close order; modal busy/focus; status filter client-side; expired-key edit; Test-now cooldown text).
5. 09.5 + 09.6 + 09.7: `gcTime: 0` + `autocomplete`, conditional `retry`, debounced request id.
6. 09.8: clock fan-out on `/accounts`.
7. 09.9 + 09.10: `safeNextPath`, coded login errors (coordinate callback wording with area 01).
8. 09.11: splits and dedupes; response schemas last.

## Tests
- Add: `apps/web/test/unit/refetch-identity.test.tsx`, `error-boundary.test.tsx`, `LoginRoute.test.tsx`. Extend: `AccountsTable.test.tsx`, `KeysTable.test.tsx`, `mutation-invalidation.test.tsx`, `routes.test.ts`, `UsageRoute.test.tsx` (request-id debounce), `KeyFormDialog.test.tsx`, `ConfirmDialog.test.tsx`, `AccountConnect.test.tsx`.
- `bun test <those files>`; `bunx biome check <changed files>`; `bun run typecheck` once at end.

## Done when
- An identical or changed poll never replaces a mounted row, group, dialog or input on any screen; the new identity test fails on current `main` and passes.
- A usage refetch replaces no `<td>` in the accounts or keys table.
- A failed chunk load or render throw shows a reload prompt, never an empty `<main>`.
- Every carry-over in 09.4 has its failure-first test green.
- No mutation-cache entry holds a credential or password after its dialog closes; a `4xx` read is fetched once.

## Not covered
- SCSS modules read by grep only (hex/rgb, outline, reduced-motion, transitions) — no visual, contrast or light-theme pass; `ui-geometry/` and its fixtures not read.
- Not read line by line: `routes/overview/OnboardingPanel.tsx`, `routes/pools/PoolFormDialog.tsx`, `routes/accounts/AccountFormDialog.tsx` / `AccountEditDialog.tsx` bodies, `routes/keys/KeyConnectSnippets.tsx`, `lib/client-snippets.ts`, `lib/failure-classes.ts`, `lib/subscription-login.ts`, `lib/account-status.ts`, `lib/api/settings.ts`, `lib/api/tasks.ts`, `lib/api/usage.ts`, `routes/settings/{Retention,WeeklyReport,PriceAddForm,PriceCoverage}*`, `price-editing.ts`. Tests skimmed by name only.
- Probes ran under happy-dom, not a real browser; 09.2 and 09.9 are reasoned, not reproduced. 12.3 / 12.4 rest on the earlier slice's evidence.
- Server-side `next` validation, the OIDC callback's error wording and the 05.10 / 05.11 chart-axis findings (API-owned) were not re-checked.
