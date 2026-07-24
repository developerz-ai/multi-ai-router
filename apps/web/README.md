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
│   │   └── …               pure mappers and formatters
│   ├── routes/             one default-exported component per screen
│   ├── layout/             AppLayout: nav, skip link, theme toggle
│   ├── components/         shared UI: Table, StatusDot, PageHeader, …
│   └── styles/             tokens, reset, shared mixins — the only global CSS
└── test/unit/              bun:test, DOM-free
```

Every screen is `lazy(() => import(...))`, so the login page ships the shell and nothing else.
`routes.ts` is the single source of truth for both the router and the sidebar — a nav entry and a
route cannot drift apart.

## Routes

| Path | Screen | Notes |
|---|---|---|
| `/login` | Sign-in | Outside the shell — no nav to pages you cannot reach yet |
| `/` | Overview | Fleet health; exhausted accounts banner |
| `/accounts` | Accounts | Status, quota, reset, re-check |
| `/pools` | Pools | Membership, policy, observed split |
| `/keys` | Keys | Named, scoped, value viewable any time |
| `/usage` | Usage | The headline surface — any dimension × any window |
| `/settings` | Settings | Prices, retention, scheduled-task health |
| `*` | Not found | Inside the layout |

## Running it

| Command | Effect |
|---|---|
| `bun run dev` | Vite on `:5173`, proxying `/v1` and `/admin` to the API on `:8080` |
| `bun run build` | Vite build → `apps/web/dist` |
| `bun run preview` | Serve the built bundle locally |

`bin/dev` at the repo root starts this and the API together. **The image is assembled by the root
`bin/build`, which places the bundle at `dist/web/`** — building this package in isolation writes
`apps/web/dist` and stops there.

## Design system

Semantic tokens only. A raw hex in a component is a bug; the palette lives in one file.

| Token | Use |
|---|---|
| `--surface` / `--surface-raised` / `--surface-sunken` | Page, card, recessed row |
| `--text` / `--text-muted` | Body, secondary and disabled |
| `--border` / `--border-strong` | Hairlines; emphasised edges |
| `--accent` / `--accent-contrast` | Interactive, focus ring; text on accent |
| `--ok` / `--warn` / `--danger` | `active`; `cooling_down`; `exhausted` and `needs_reauth` |

`src/styles/tokens.scss` defines both schemes from one pair of mixins: dark on `:root` (dark-first),
light under `@media (prefers-color-scheme: light)`, then `:root[data-theme="dark"|"light"]`. The
attribute selectors outrank bare `:root` on specificity, inside the media query as well as outside,
so an explicit choice wins in **both** directions — dark OS + light chosen, and the reverse.
`"system"` removes the attribute rather than writing a value.

`src/styles/reset.scss` is the only other global sheet: focus-visible is restyled and never removed,
and `prefers-reduced-motion: reduce` neutralises transitions and animations app-wide.

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
nowMs)`), never read inside.

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
| Domain enums | Import them from `@multi-ai-router/core`, as **types only** — `import type { AccountStatus }`. A value import of a Zod enum drags Zod into the browser bundle: measured at **+51 kB raw / +14.3 kB gzip** to read five string literals. Where an ordered list is needed, `STATUS_DISPLAY_ORDER` is presentation data, `satisfies`-checked against core's union and permutation-tested against `AccountStatus.options` |
| No fallback branches on an enum | The reset-source bug was a ternary whose `else` silently relabeled anything unrecognised as "estimated". Map enum values through an exhaustive `Record` so a new member fails the build instead |
| tsc emit | A composite project may not set `noEmit`, so type-check declarations land in the gitignored `dist-types/`. Vite emits the real bundle |
| Lazy routes | `lazy()` needs a **default** export. Screens in `routes/` and `AppLayout` export default for that reason; everything else in `src/` uses named exports |

## See also

- [`docs/idea/08-observability.md`](../../docs/idea/08-observability.md) — what the usage, quota and
  reset surfaces must show, and the data shapes behind them.
- [Admin GUI and usage in the root README](../../README.md#-usage--cost) — the operator-facing
  description of the same surfaces.
- `gold-standards-in-ai/docs/stack/frontend-solidjs.md` — the org SolidJS standard this follows,
  Tailwind excepted.
