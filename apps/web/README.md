# `@multi-ai-router/web`

The SolidJS admin console: a Vite SPA the operator uses to attach accounts, mint keys, and read usage.

## What it owns

Rendering and client-side state. Nothing else.

| Belongs here | Does not |
|---|---|
| Route shell, layout, components, SCSS modules, design tokens | Business logic — routing policy, quota math, cost estimation. Those are pure functions in `apps/api` and `packages/core` |
| Server state via TanStack Solid Query, keyed to admin endpoints | Its own copy of a domain rule. The API's answer is the answer |
| Presentation mapping (status → token, timestamp → countdown) | Any credential. The SPA never holds a router key or an upstream token |
| Display order, labels, wording | The **vocabulary** itself. `AccountStatus`, `ResetSource` and friends come from `@multi-ai-router/core` and are never restated here |

Built output is served as static assets by the Hono process, **same origin**. That is why cookie auth
and CSRF work with no CORS layer anywhere — and why the dev server proxies rather than allowing
cross-origin requests.

## Layout

```
apps/web/
├── index.html              Vite entry; mounts #root
├── vite.config.ts          solid plugin, dist output, dev proxy → :8080
├── tsconfig.json           DOM overrides on top of tsconfig.base.json
├── src/
│   ├── main.tsx            render() under QueryClientProvider
│   ├── App.tsx             maps the route table onto <Route> elements
│   ├── lib/
│   │   ├── routes.ts       lazy route table — one chunk per screen
│   │   ├── query.ts        the TanStack Query client, configured once
│   │   ├── api/            the only place that knows about fetch — see below
│   │   ├── queries/        one hook module per resource + the query-key factory
│   │   └── …               pure mappers and formatters
│   ├── routes/             one default-exported component per screen
│   │   └── <screen>/       that screen's tables and dialogs
│   ├── layout/             AppLayout: sidebar/drawer, session guard, theme
│   ├── components/         shared UI: Table, StatusDot, Modal, Button, …
│   └── styles/             the only global CSS — see below
└── test/unit/              bun:test, DOM-free
```

`src/styles/` is split by reason to change, not by convenience:

| File | Contains, and nothing else |
|---|---|
| `_tokens.scss` | Custom-property declarations. The two scheme mixins exist only so one token set can be declared twice |
| `_breakpoints.scss` | The `$breakpoints` map and the `respond-to` / `respond-to-fine` mixins built from it |
| `_mixins.scss` | Reusable patterns. Depends on `_breakpoints`; declares no tokens |
| `reset.scss` | Element reset and the document shell. The only place bare element selectors are allowed |
| `global.scss` | The entry barrel `main.tsx` imports: tokens, then reset |

Every screen is `lazy(() => import(...))`, so the login page ships the shell and nothing else.
`routes.ts` is the single source of truth for both the router and the sidebar — a nav entry and a
route cannot drift apart.

## Routes

Every screen below renders live admin data, Usage included. The one exception is marked in the UI
itself, on the screen and not only here: the four Settings sections listed as unbuilt have no
endpoint behind them.

| Path | Screen | What it shows |
|---|---|---|
| `/login` | Sign-in | Outside the shell. Posts to `/api/admin/auth/login`; `?next=` returns you to the surface your session expired on |
| `/` | Overview | Live account/pool/key counts, accounts-by-status, and a **red banner naming every `exhausted` account** |
| `/accounts` | Accounts | Status, availability, credential kind, re-check per account and for all, add, disable, delete |
| `/pools` | Pools | Membership, policy, overflow account, and how many members are routable *now* |
| `/keys` | Keys | Named, scoped, mint, revoke, delete — and **reveal, any time, no shown-once flow** |
| `/usage` | Usage | Any dimension × any window, from `GET /api/admin/usage`. Requests and attempts, and metered and notional spend, are shown as separate measures and never summed |
| `/settings` | Settings | Live session and provider registry; prices, retention, task health and audit still unbuilt |
| `*` | Not found | Inside the layout |

## Server state

Three layers, and the boundary between them is the point.

| Layer | Owns |
|---|---|
| `lib/api/client.ts` | The only `fetch` in the app. Prefixes `/api/admin`, sets `credentials: "same-origin"`, puts `x-csrf-token` on **every** mutating method, and turns a non-2xx into an `ApiError` carrying the server's own sentence |
| `lib/api/<resource>.ts` | One module per endpoint group, plus the wire types — declared here, never imported from `apps/api`. The shared *vocabulary* still comes from `@multi-ai-router/core` |
| `lib/queries/<resource>.ts` | The TanStack hooks and their invalidation. Keys come from `queryKeys` in `lib/queries/query-keys.ts` and are never written inline |

Three rules worth stating because they are easy to get wrong:

- **A 401 anywhere is a session event, not a page error.** `client.ts` flips one `sessionLost`
  signal; `AppLayout` has the only effect that reads it and routes to `/login?next=…`. No route
  decides for itself what its own 401 means.
- **`queryKeys.<resource>.root()` is a prefix of every key beneath it**, which is what makes
  `invalidateQueries({ queryKey: root })` catch the filtered lists and the details too. A unit test
  asserts the prefix relation.
- **Invalidation crosses resources where the data does.** An account write invalidates pools,
  because `PoolMemberView` embeds the account's label and status; an account or pool delete also
  invalidates keys, because scope targets cascade.

`QueryBoundary` renders the three states — `TableSkeleton`, `ErrorState` with a retry, content — and
reads `query.data` **only** inside the success branch. `data` is backed by a Solid resource; reading
it while pending suspends the nearest boundary and the skeleton never appears.

## Running it

| Command | Effect |
|---|---|
| `bun run dev` | Vite on `:5173`, proxying `/api`, `/v1`, `/healthz` and `/readyz` to the API on `:8080` |
| `bun run build` | Vite build → `apps/web/dist` |
| `bun run preview` | Serve the built bundle locally |

The proxy prefixes are the ones the API actually mounts — `ADMIN_*_BASE_PATH` is `/api/admin/<group>`
for every admin group, so `/api` covers all five. A prefix that is *nearly* right fails silently:
the request lands on Vite's own 404 and reads as a broken API rather than a broken config.

`bin/dev` at the repo root starts this and the API together. **The image is assembled by the root
`bin/build`, which places the bundle at `dist/web/`** — building this package in isolation writes
`apps/web/dist` and stops there.

## Navigation and responsive strategy

**Mobile-first, literally.** Base styles are the phone layout; every media query is `min-width`.
There is no `max-width` query in the codebase — wider viewports *add* the sidebar rather than
narrower ones taking it away.

| Width | Navigation |
|---|---|
| Base | Sticky top bar with a hamburger; the nav is an off-canvas drawer over a scrim |
| ≥ `48rem` | The same nav element becomes a permanent full-height vertical sidebar; the top bar is `display: none` |

One `<nav>` serves both. Nothing is duplicated, so a link cannot exist in one layout and not the
other. The sidebar is `position: sticky` inside its own grid column rather than `fixed`: it behaves
like a fixed rail but still occupies layout, so `main` needs no compensating margin.

**Why a drawer and not a bottom bar.** A bottom bar is the better pattern at three to five
destinations. This console has six plus a theme control, which is past the point where a bottom bar
starts truncating labels or hiding items behind "More" — and truncated labels are exactly wrong for
a tool where `/pools` and `/keys` mean specific things. The drawer holds all six at full label width
with room for the icon.

Drawer behaviour, all verified in a browser at 320px:

| Requirement | How |
|---|---|
| Toggle is keyboard reachable and named | Real `<button>` with `aria-expanded`, `aria-controls`, and a label that flips between "Open/Close navigation" |
| Focus trapped while open | `createFocusTrap` cycles Tab within the drawer; focus moves to the first link on open |
| Focus restored on close | Returns to the hamburger, via the trap's `restoreTo` |
| `Escape` closes | Handled in the trap's keydown listener |
| Hidden from the a11y tree when closed | `visibility: hidden` (not merely offscreen) plus the `inert` attribute. `inert` is applied only below the breakpoint — a sidebar is never inert |
| No scroll trap | The page is locked only while open and released deterministically on close *and* on unmount; the drawer scrolls itself with `overscroll-behavior: contain` |

The `visibility` transition is asymmetric, which is load-bearing: opening flips it immediately
because `.focus()` is a no-op on a `visibility: hidden` element, while closing delays the flip until
the slide-out finishes. Getting this wrong silently breaks the focus trap — it did, once.

### Tables on a phone

Wide tables scroll **inside their own container**, and the first column is pinned. The page itself
never scrolls horizontally at 320px; the `minmax(0, 1fr)` grid tracks in `AppLayout.module.scss` are
what prevent a wide table from widening the whole document.

Reflowing each row into a stacked card was considered and rejected. The operator's question is
comparative — *which* key is spending most, *which* account is throttled — and cards destroy
row-to-row comparison by putting one record per screen. A CSS row-to-card transform also breaks the
table semantics screen readers rely on and duplicates every header string into `::before` content.
Pinning the identity column solves the one real weakness of scrolling, which is losing track of
which row a number belongs to.

## Design system

Semantic tokens only. A raw hex in a component is a bug; the palette lives in one file.

| Token | Use |
|---|---|
| `--surface` / `--surface-raised` / `--surface-overlay` / `--surface-sunken` | Page, card, floating, recessed |
| `--text` / `--text-muted` | Body; secondary |
| `--border` / `--border-strong` | Hairline separators; emphasised edges |
| `--accent` / `--accent-soft` / `--accent-contrast` | Interactive and focus ring; active tint; text on accent |
| `--ok` / `--warn` / `--danger` | `active`; `cooling_down`; `exhausted` and `needs_reauth` |
| `--scrim`, `--shadow-1`, `--shadow-2` | Modal backdrop; the only two elevation levels |
| `--space-1…8`, `--radius-1/2/full`, `--text-xs…2xl`, `--weight-*`, `--line-*`, `--tracking-*` | The scales. Nothing in a component is an off-scale magic number |
| `--duration-fast/base/drawer`, `--ease-out` | Motion. Nothing exceeds 200ms |

`_tokens.scss` defines both schemes from one pair of mixins: dark on `:root` (dark-first), light
under `@media (prefers-color-scheme: light)`, then `:root[data-theme="dark"|"light"]`. The attribute
selectors outrank bare `:root` on specificity, inside the media query as well as outside, so an
explicit choice wins in **both** directions — dark OS + light chosen, and the reverse. `"system"`
removes the attribute rather than writing a value.

**Contrast is checked, not assumed.** Every foreground token clears WCAG AA (4.5:1) against every
surface it can sit on, in both schemes. Worst pairing is 4.75:1 (light `--accent` on
`--surface-sunken`); `--text-muted` — the token a dark UI usually fails on — is 7.11:1 dark and
5.75:1 light against `--surface-raised`. The light `--accent`, `--ok` and `--danger` are darker than
their dark-scheme twins for this reason; the naive "same hue in both schemes" palette failed on
`--surface-sunken`.

`reset.scss` is the only other global sheet: focus-visible is restyled and never removed, and
`prefers-reduced-motion: reduce` neutralises transitions and animations app-wide. The skeleton
shimmer additionally drops its gradient under that query, because a clamped animation would
otherwise freeze mid-sweep.

### SCSS rules

1. **One module, one component.** `Foo.module.scss` styles `Foo` only. A parent styles the *slot* it
   provides (`.navFooter` is `display: grid`) and never reaches into a child's rules.
2. **Class-scoped only.** No bare element selectors outside `reset.scss`; no `:global`; no
   `!important`. All three are grep-enforceable and currently return nothing.
3. **Extend by variant or token**, never by editing an existing rule. Every colour, radius, shadow
   and spacing value in a component is a `var(--…)`.
4. **A visual pattern earns a mixin on its third caller.** `overlay` was deleted for having one —
   the drawer writes its two elevation declarations out. **Accessibility and interaction policies
   are the deliberate exception** and are centralised on first use: `focus-ring`, `visually-hidden`
   and `tappable` each have two callers, because two components disagreeing about focus or touch
   target size is a defect, not a style difference.
5. **Mixins take only what they vary on.** `numeric` was split into `tabular-figures` (the digits)
   and `numeric` (digits + column alignment) so a headline figure can take the first without
   inheriting `text-align: right`.

> **Deliberate deviation from the org standard.** `docs/stack/frontend-solidjs.md` specifies
> Tailwind. This app uses SCSS modules + CSS custom properties because the operator chose it
> explicitly, and `CLAUDE.md` records it as the project stack. Not an oversight — do not "fix" it.

> **Deliberate deviation from the org standard.** `docs/stack/frontend-solidjs.md` specifies
> Tailwind. This app uses SCSS modules + CSS custom properties because the operator chose it
> explicitly, and `CLAUDE.md` records it as the project stack. Not an oversight — do not "fix" it.

## Solid idioms

Non-negotiable in every component here, because this scaffold is what future components get copied
from.

| Rule | Why |
|---|---|
| Never destructure props | Destructuring reads once and severs the prop from the reactive graph permanently. Use `props.x`; `mergeProps` for defaults, `splitProps` to separate |
| Control flow is components | `<Show>`, `<For>`, `<Switch>`/`<Match>` — not `&&`, a ternary, or `.map()`. `<For>` is keyed by reference, which is what lists of objects want; `<Index>` only when position *is* the identity |
| Derived values are `createMemo` | Not recomputed in the component body, not a plain function called three times in one template |
| `createEffect` is a last resort | Only for syncing to something outside the reactive graph — `ThemeToggle` writing `data-theme` onto `<html>` is the one instance. It is not `useEffect`; never derive state with it |

One deliberate exception: `App.tsx` uses `.map()` over the route table. The router walks its children
once at setup to build the match tree and cannot walk a `<For>` memo — and a static route table is
configuration, not reactive data.

## Testing

```
bun test apps/web
```

Deliberately DOM-free — pure mappers and formatters, with the clock injected (`describeReset(input,
nowMs)`, `formatRelative(iso, nowMs)`), never read inside.

| File | Asserts |
|---|---|
| `account-status`, `reset-countdown`, `theme` | The presentation rules: `exhausted` never gets a countdown, a status added to core has a presentation |
| `routes` | The route table, and that `?next=` cannot redirect off this origin |
| `api-client` | Every mutating method carries `x-csrf-token`; absent filters are dropped, not serialised |
| `api-errors` | Both error shapes parse; a failure always renders as a sentence, never a bare status |
| `query-keys` | Every key is prefixed by its resource root, and the roots are disjoint |
| `format`, `usage` | Number and time formatting; the usage contract — attempts ≥ requests, percentiles do not sum |

**Component tests are deferred, as a decision rather than an omission.** The house standard is
`@solidjs/testing-library` + `bun test`, and it does work — it was built and verified at 33/33 in a
clean install before being withdrawn. It was not kept because the harness needs five separate
workarounds for one status dot: a Babel `babel-preset-solid` transform registered as a Bun plugin
(Bun's built-in JSX transform is React's, and `jsxImportSource` alone gives Solid's runtime JSX
without the `babel-plugin-jsx-dom-expressions` compilation reactivity depends on), a stub loader for
`*.module.scss`, `@happy-dom/global-registrator` **≥ 20** (17.x drops `<tr>`/`<td>` when parsing
template fragments, so no table renders), `--conditions=browser --conditions=development` on the
command line (Bun otherwise resolves the *server* build of `solid-js/web` and every render throws
"Client-only API called on the server side" — and bunfig has no key for it, so it cannot live in
config), and a root test-runner change so `bun test` from the repo root does not pick the `.tsx`
files up without any of the above. Revisit when a component has behaviour a pure function cannot
cover; the recipe above is the whole of it.

## Gotchas

| | |
|---|---|
| tsconfig | This package **replaces** `lib` and `types` from `tsconfig.base.json`. The base targets Bun: no `DOM` lib, `types: ["bun"]`. Extending without overriding both fails to type-check |
| Class names | CSS-module lookups are `string \| undefined` under `noUncheckedIndexedAccess`. Template concatenation emits the literal `"undefined"` into `class` — use `cx()` from `src/lib/cx.ts` |
| Status colour | Colour never carries meaning alone. `needs_reauth` and `exhausted` share `--danger` and differ by dot fill (hollow vs. solid) plus label; `cooling_down` (`--warn`) is never folded in with either |
| Reset display | `exhausted` shows "needs top-up" and never a countdown, and a reset whose source is `unknown` shows no countdown at all |
| Breakpoint duplication | `48rem` lives in `_breakpoints.scss` *and* in `lib/media.ts` as `SIDEBAR_QUERY`. The focus trap must know when the drawer stops being modal, and CSS cannot hand a value to JS. Change both; no test catches this |
| Domain enums | Import them from `@multi-ai-router/core`, as **types only** — `import type { AccountStatus }`. A value import of a Zod enum drags Zod into the browser bundle: measured at **+51 kB raw / +14.3 kB gzip** to read five string literals. Where an ordered list is needed, `STATUS_DISPLAY_ORDER` is presentation data, `satisfies`-checked against core's union and permutation-tested against `AccountStatus.options` |
| No fallback branches on an enum | The reset-source bug was a ternary whose `else` silently relabeled anything unrecognised as "estimated". Map enum values through an exhaustive `Record` so a new member fails the build instead |
| tsc emit | A composite project may not set `noEmit`, so type-check declarations land in the gitignored `dist-types/`. Vite emits the real bundle |
| Lazy routes | `lazy()` needs a **default** export. Screens in `routes/` and `AppLayout` export default for that reason; everything else in `src/` uses named exports |

## What the API still owes this console

Two gaps, both visible on screen rather than hidden — a console that quietly invents a number is
worse than one that says it has none.

**1. The usage read API.** Everything on `/usage`, and three of the six Overview tiles, is generated
from a fixed seed in `src/lib/api/usage.ts`. That file is the whole of it: the types below are the
contract the screens already render against, so landing the endpoint means replacing one function
body with a `request()` call and flipping `placeholder` to `false`. No route, component or query key
changes.

```
GET /api/admin/usage?window=today|7d|30d|lifetime
GET /api/admin/usage?from=<iso>&to=<iso>              custom window
→ UsageSummary { window, bucket: "hour"|"day", from, to,
                 totals: UsageTotals, series: number[],
                 byKey, byAccount, byPool, byModel: UsageBreakdownRow[] }
```

`UsageTotals` keeps three pairs apart, and they must never be pre-summed by the server:
`requests` / `attempts` (a failover chain of three is one request and three attempts),
`costMetered` / `costNotional` (a subscription account has no per-token price, only an
attribution), and `tokensIn` / `cacheReadTokens` / `cacheWriteTokens` (total prompt size is the sum
of all three).

**2. Quota state on `AccountView`.** The Availability column is built on `ResetIndicator`, which
already renders absolute time *and* countdown *and* a reported/estimated qualifier — but
`AccountView` carries no quota window, so today it can only say "Needs top-up — no reset" for an
`exhausted` account and "Unknown — will retry with backoff" for a `cooling_down` one. Both are true;
neither is useful. Adding core's `QuotaWindowState` to the view fills the column with no UI change.

**3. `lastCheckedAt` on `AccountView`.** `POST /accounts/:id/recheck` returns it, so the row can show
it after a press — but nothing carries it on a cold load, so a fresh tab says "Not checked from this
console" rather than inventing a time. CLAUDE.md asks for the last-checked timestamp to be *always*
visible; that needs the field on the read.

## See also

- [`docs/idea/08-observability.md`](../../docs/idea/08-observability.md) — what the usage, quota and
  reset surfaces must show, and the data shapes behind them.
- [Admin GUI and usage in the root README](../../README.md#-usage--cost) — the operator-facing
  description of the same surfaces.
- `gold-standards-in-ai/docs/stack/frontend-solidjs.md` — the org SolidJS standard this follows,
  Tailwind excepted.
