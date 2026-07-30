# Frontend UI Bug Hunt — 2026-07-30

Static code review of `apps/web/` (SolidJS SPA). 28 findings across 5 angles:
layout & visual, state & async, accessibility, forms & input, theme & styling.

**Method:** read-only deep review by 5 parallel `general-purpose` agents under the
`MiniMax-M3[1m]` model. No live browser test was performed — interaction, hydration,
and real responsive bugs would still need a run.

## Severity summary

| Severity | Count |
|---|---|
| HIGH | 8 |
| MEDIUM | 8 |
| LOW | 12 |
| **Total** | **28** |

## Angles covered

1. **Layout & visual** — responsive breakage, overflow, z-index, image/icon gaps
2. **State & async** — missing loading/error states, race conditions, query misuse
3. **Accessibility** — aria, keyboard, focus, contrast, prefers-reduced-motion
4. **Forms & input** — validation, submit handling, autocomplete, paste handling
5. **Theme & contrast** — hard-coded tokens, dark-mode breaks, dead styles

## Findings

### HIGH (8)

#### 1. `apps/web/src/components/Modal.module.scss:26` — safe-area

Mobile bottom-sheet modal panel has no `padding-bottom: env(safe-area-inset-bottom)`. The `.panel` is anchored to the viewport bottom via `.layer { align-items: flex-end }` and `border-radius: var(--radius-2) var(--radius-2) 0 0`, but the footer row (Cancel/Save/Submit buttons) can be partially hidden behind the iOS home indicator gesture bar on notched devices, leaving the primary action visually clipped or unreachable.

**Evidence:**

```
Modal.module.scss lines 4-18 (`.layer` flex-end alignment), lines 26-46 (`.panel` padding `var(--space-4)` without safe-area-inset adjustment). Every dialog (AccountForm, AccountEdit, Connect, KeyForm, PoolForm, Confirm) inherits this.
```

#### 2. `apps/web/src/routes/accounts/AccountConnect.tsx:70` — state-mgmt

Redirect-completion detection fires on the begin call itself, not on the OAuth callback. `setStartedAt` is captured in `onBegin` BEFORE `begin.mutate` (line 116) from the watched row's CURRENT `updatedAt`. The begin endpoint bumps the row's `updatedAt` server-side, so the next 3-second poll sees `row.updatedAt !== before` and the effect immediately calls `setCompleted({ connected: true, capture: "redirect" })`. The dialog then announces "Connected" without the user having authorized anything — the same false positive the comment in the file (lines 33-37) explicitly tries to prevent. Fix: capture `updatedAt` inside `begin.mutate.onSuccess` (or as `result.updatedAt`) and only mark complete on a second bump past that baseline.

**Evidence:**

```
lines 70-83 (detection effect), 112-120 (onBegin, captures `watched.data?.updatedAt` before begin). The watched `updatedAt` cannot survive the begin call's server-side write, so `row.updatedAt === before` is never true after the first post-begin refetch.
```

#### 3. `apps/web/src/routes/accounts/AccountRecheck.tsx:60` — missing-live-region

Re-check button has no live region for its result. After the operator presses Re-check, the outcome ('Eligible again — status updates on the next request' or 'On cooldown — next check ...') renders inside plain <span class={styles.note}> / <span class={styles.line}> elements. A screen reader user receives no audible confirmation of the press's outcome. The query result is silent — the only signal the AT user gets is the value-side line 'Checked ...' which is already in the DOM and unchanged on success.

**Evidence:**

```
lines 54-87: <Show fallback={...} when={checkedAt()}> and <Show fallback={...} when={!pressed().rechecked}> wrap the dynamic result spans; no aria-live, no role=status on the wrapper.
```

#### 4. `apps/web/src/routes/accounts/AccountTestNow.tsx:73` — missing-live-region

Test now button has no live region for its result. After the test completes, the 'Answered' / 'Failed' line with timestamp, relative time, and (optional) message appears inside <span class={styles.line}> with no aria-live wrapper. Same problem as AccountRecheck — the user just clicked the button and gets no audible feedback. The cooldown line ('On cooldown — next test ...') is similarly silent.

**Evidence:**

```
lines 73-95: <Show when={last.isSuccess ? last.data : null}> wraps the result <span>s. The button itself (line 69) carries no aria-busy or aria-live that could carry the announcement.
```

#### 5. `apps/web/src/routes/accounts/AccountModels.tsx:49` — missing-live-region

Discover button result is silent. After Discover runs, the model count badge swaps from '0 models' to e.g. '6 models' and the preview list updates, but the wrapping <div> has no aria-live, no role=status. The operator pressed the button and the only signal is a visual change.

**Evidence:**

```
lines 41-56: <Badge title={...}>{declared().length} model{...}</Badge> and <span class={styles.preview}>{declared().slice(0, PREVIEW).join(', ')}</span> render inside <Show when={declared().length > 0}> with no live region above them.
```

#### 6. `apps/web/src/components/ThemeToggle.tsx:30` — aria-misuse

aria-live='polite' is placed on the toggle <button>. aria-live only takes effect on text content / status containers; placing it on an interactive element has no announcement effect in mainstream screen readers. The button's visible label changes between 'System' / 'Dark' / 'Light' on click and there is no separate live region to carry the announcement, so the screen reader user cycles themes blind.

**Evidence:**

```
line 30: <button class={styles.button} type='button' onClick={cycle} aria-live='polite'>{themeLabel(preference())}</button>. The textContent mutates on click; nothing else wraps it.
```

#### 7. `apps/web/src/routes/accounts/AccountEditDialog.tsx:254` — html5-validation-conflicts-with-clear-to-retry

Weight and Priority TextFields carry `required` + `min={1}`/`min={0}` while the submit-side `numeric()` helper (lines 296-303) is deliberately designed to fall back to the stored value when the box is empty/unparseable. HTML5 `required` blocks submission of an empty box, so the operator cannot clear the field to retype (a deliberate UX pattern that exists because weight=0 silently drops the member out of the weighted policy). The fallback is dead code for the same scenario it exists to handle, and any account with weight=0 in storage cannot be saved through the form because `min={1}` rejects it.

**Evidence:**

```
AccountEditDialog.tsx 254-278 TextField with required + min; 296-303 Number.isFinite ? parsed : current. The two halves disagree on the empty-box contract.
```

#### 8. `apps/web/src/routes/pools/PoolFormDialog.tsx:262` — html5-validation-blocks-mid-edit-clear

TuningInput (used for member weight/priority inside the pool members <fieldset>) has `required` + `min={props.min}` (1 for weight, 0 for priority). The `tune()` function (lines 117-128) explicitly returns early when the parsed value is not finite to preserve the existing value — the code comment says "An emptied box is held as-is rather than coerced to 0: weight: 0 would drop the member out of the weighted policy entirely". But `required` blocks submit before that path runs. Operators cannot clear-and-retry a weight or priority value; they must first type a valid number into the already-cleared box.

**Evidence:**

```
PoolFormDialog.tsx 117-128 (tune) and 262-281 (TuningInput required + min). Same comment-vs-enforcement mismatch as AccountEditDialog.
```

### MEDIUM (8)

#### 1. `apps/web/src/routes/accounts/ConnectResult.tsx:25` — empty-placeholder

ConnectResult always renders its `<section class={styles.success}>` wrapper with border, padding and background, but its children are gated on `<Show when={props.completed}>`. When the dialog is open without a completed login, an empty bordered box renders between the dialog sections — visible placeholder that is not actually empty.

**Evidence:**

```
The section element at line 25 is mounted unconditionally; only the children are wrapped in `<Show when={props.completed}>`. The `.success` class in ConnectDialog.module.scss applies `border: 1px solid var(--ok)`, `padding: var(--space-3)`, `background: color-mix(...)` so a non-empty empty box is rendered.
```

#### 2. `apps/web/src/layout/AppLayout.module.scss:21` — safe-area

Mobile topbar lacks `padding-top: env(safe-area-inset-top)`. The sticky topbar at z-index 20 with the menu button and brand label can be partially obscured by the iOS notch / dynamic island on notched phones, hiding the Open Navigation button.

**Evidence:**

```
AppLayout.module.scss lines 21-31: `.topbar { position: sticky; top: 0; padding: var(--space-2) var(--space-3); }` with no safe-area-inset-top adjustment.
```

#### 3. `apps/web/src/routes/accounts/AccountsTable.module.scss:7` — overflow-wrap

The AccountsTable identity column's `.label` (account label) lacks `overflow-wrap: anywhere`, while sibling tables (KeysTable `.name`, PoolsRoute `.name`, UsageBreakdown `.label`) all have it. A long account label overflows the pinned first column horizontally and pushes the row width.

**Evidence:**

```
AccountsTable.module.scss: `.label { font-weight: var(--weight-medium); }` (line 7-9). Compare KeysTable.module.scss `.name` (line 9-12) which sets `overflow-wrap: anywhere`.
```

#### 4. `apps/web/src/components/PageHeader.module.scss:22` — flex-wrap-missing

PageHeader's `.actions` flex container lacks `flex-wrap: wrap`. When the PageHeader root wraps on narrow screens and moves `.actions` to its own line, the inner items (e.g. Overview's segmented `windows` fieldset + Re-check button) can overflow the actions container horizontally because the inner flex row does not wrap.

**Evidence:**

```
PageHeader.module.scss lines 22-26: `.actions { display: flex; gap: var(--space-2); align-items: center; }` — no flex-wrap. Used by OverviewRoute (windows + button), AccountsRoute (Re-check + Add), KeysRoute (Mint), UsageRoute (windows fieldset).
```

#### 5. `apps/web/src/routes/pools/PoolFormDialog.tsx:105` — initial-value-vs-min-mismatch

When an account is toggled into the pool, the new member is seeded from `account.weight` and `account.priority` (lines 105-115). If either account ever carries weight=0 (legal under the tuning schema, e.g. legacy or pre-policy value), the seeded member passes 0 into a TuningInput whose `min={1}`. The form is unrenderable for that member until the operator manually bumps the value; combining a stale 0 weight with the high-severity `required` finding above means the whole pool save can lock.

**Evidence:**

```
PoolFormDialog.tsx 105-115 seeds member weight from account.weight; TuningInput min=1.
```

#### 6. `apps/web/src/routes/settings/PriceAddForm.tsx:35` — missing-html5-required

Both the Provider SelectField and the Model TextField lack `required`, despite both being mandatory. Validation lives only in `add()` at lines 132-135, so an operator gets `setAddError("Pick a provider and name a model.")` post-submit instead of native HTML5 prevention, and the field carries no required indicator (Field.tsx renders the asterisk only when `rest.required === true`). The submit button is enabled even when both fields are empty.

**Evidence:**

```
PriceAddForm.tsx 35-53 no `required` on either control; 132-135 sets the error string instead.
```

#### 7. `apps/web/src/components/Sparkline.module.scss:4` — hardcoded-token-bypass

`.chart` declares `color: var(--accent);` directly, so the sparkline is always drawn in the accent colour regardless of the surrounding cell's tone. Used inside `QuotaWindowRow .trend` and `UsageTopN .trend`, both of which set `color: var(--text-muted)` on the parent — the inheritance the component docstring promises (Sparkline.tsx:21-22: "currentColor throughout, so a sparkline inherits whatever the cell's tone already is and never introduces a colour of its own") never happens. Warn/danger-toned call sites cannot recolor the line.

**Evidence:**

```
Sparkline.module.scss:4 `color: var(--accent);` overrides parent `color: var(--text-muted)` from QuotaWindowRow.module.scss:36 and UsageTopN.module.scss:151; the stroke at Sparkline.module.scss:9 reads `currentcolor` and so always resolves to accent.
```

#### 8. `apps/web/src/components/Button.module.scss:51` — non-token-color-effect

`.primary:hover:not(:disabled)` uses `filter: brightness(1.08);`, a non-token CSS filter that brightens the entire element including all child content (icon, spinner, label). It does not use a scheme-specific token and produces different perceived hover feedback between the dark accent (#5b9dff) and the darker light accent (#1a63dd). The repo rule "Semantic tokens only... never a raw hex in a component" is violated by the constant 1.08 brightness multiplier.

**Evidence:**

```
Button.module.scss:49-52 `&:hover:not(:disabled) { border-color: var(--accent); filter: brightness(1.08); }` — no token, applies to whole subtree including Icon children rendered via stroke="currentColor".
```

### LOW (12)

#### 1. `apps/web/src/layout/AppLayout.module.scss:217` — overflow-protection

The sidebar footer `.version` element has no max-width, overflow-wrap, or min-width:0 on its grid parent, so a long version string (e.g. an extended git SHA, `v2026.07.30-abcdef1.2026-07-30T12:34:56Z`) overflows the sidebar's width and produces horizontal scroll inside the drawer.

**Evidence:**

```
AppLayout.module.scss lines 217-223: `.version { padding-inline: var(--space-2); color: var(--text-muted); font-family: var(--font-mono); font-size: var(--text-xs); line-height: var(--line-snug); }` — no overflow-wrap. The `.navFooter` grid parent also lacks `min-width: 0`.
```

#### 2. `apps/web/src/routes/accounts/AccountsTable.module.scss:11` — overflow-protection

AccountsTable `.provider` (provider id rendered under the label) has no overflow-wrap, so a long provider id (e.g. a custom id like `claude-code-billing-api`) overflows the identity column.

**Evidence:**

```
AccountsTable.module.scss lines 11-15: `.provider { color: var(--text-muted); font-size: var(--text-xs); font-weight: var(--weight-normal); }` — no `overflow-wrap: anywhere`.
```

#### 3. `apps/web/src/routes/settings/TaskHealthSection.module.scss:16` — overflow-wrap

`.name` in TaskHealthSection identity cell lacks `overflow-wrap: anywhere`. While current task names are short, a future rename or longer label would overflow the cell horizontally.

**Evidence:**

```
TaskHealthSection.module.scss lines 16-18: `.name { font-weight: var(--weight-medium); }` — no overflow-wrap.
```

#### 4. `apps/web/src/layout/AppLayout.module.scss:147` — flex-item-overflow

Sidebar `.navFooter` is a CSS grid container with `justify-items: start` but no `min-width: 0`. Its grid children (`.identity` in particular) can push the column past the sidebar's `var(--drawer-width)` because intrinsic content widths participate in grid track sizing. Combined with the sidebar's `overflow-y: auto` (not `overflow-x: hidden`), horizontal scroll appears inside the drawer when the username is long.

**Evidence:**

```
AppLayout.module.scss lines 194-201 (`.navFooter` lacks min-width:0) and lines 206-213 (`.identity` only has `max-width: 100%; overflow-wrap: anywhere;` — but the grid track sizes to content).
```

#### 5. `apps/web/src/routes/PoolsRoute.module.scss:12` — nowrap-overflow

`.member` in the pools table has `white-space: nowrap` but no `overflow-wrap: anywhere`. Long account labels in the membership column will overflow the cell horizontally and force the table scroller wider than necessary.

**Evidence:**

```
PoolsRoute.module.scss lines 12-18: `.member { display: flex; gap: var(--space-2); align-items: center; font-size: var(--text-sm); white-space: nowrap; }`.
```

#### 6. `apps/web/src/components/StatTile.tsx:19` — aria-noise

aria-busy='false' is rendered when the tile has loaded. The default value of aria-busy is 'false'; setting it explicitly is redundant and adds attribute noise that some screen readers re-announce. The attribute should only be present (with value 'true') while the tile is loading.

**Evidence:**

```
line 19: <div aria-busy={props.value === undefined ? 'true' : 'false'} class={styles.tile}>. The 'false' branch should omit the attribute (or return undefined).
```

#### 7. `apps/web/src/routes/accounts/ConnectDialog.tsx:216` — missing-maxlength

The paste textarea has no `maxlength`. An absurdly large paste (a full HTML page, a multi-megabyte URL fragment) would land in the signal, classify on every keystroke (re-running the URLSearchParams parse), and visually blow past the `rows={3}` height. Not an active bug; defensive cap or inputmode hardening would harden against footguns.

**Evidence:**

```
ConnectDialog.tsx 210-227 form + textarea; classifyPaste re-runs per onInput.
```

#### 8. `apps/web/src/routes/accounts/AccountTestNow.tsx:62` — missing-autocomplete

The model name TextField has no `autocomplete` attribute. Model names aren't in the WHATWG autocomplete vocabulary, but explicit `autocomplete="off"` keeps password managers and autofill out of a field whose value is sent to an upstream — the same posture used on credential fields in this codebase.

**Evidence:**

```
AccountTestNow.tsx 62-68 has no autocomplete prop; compare AccountFormDialog.tsx 200-210 / AccountEditDialog.tsx 159-171 which set `autocomplete="off"` on credential paste boxes.
```

#### 9. `apps/web/src/routes/keys/KeyFormDialog.tsx:149` — disabled-state-missing-when-dynamic-blocker-present

The Mint/Save button is `busy={props.busy}` only — never `disabled`. The submit handler computes `blocker()` (lines 122-126) and silently returns when scope is non-all and zero targets are selected, leaving a stale "nothing happened" with no busy/spinner/disabled cue. HTML5 `required` catches the label field, but the scopes-with-no-targets case is JS-only and the button still looks pressable.

**Evidence:**

```
KeyFormDialog.tsx 122-139 (blocker + early-return) vs 149-152 (footer Button with no disabled prop).
```

#### 10. `apps/web/src/components/Sparkline.tsx:21` — doc-vs-code-mismatch

The component doc comment promises `currentColor throughout, so a sparkline inherits whatever the cell's tone already is and never introduces a colour of its own`, but Sparkline.module.scss:4 forces `color: var(--accent)` on `.chart`. The implementation does the opposite of what the comment claims — readers of the source will be misled. Either the comment should be corrected, or the `.chart { color: var(--accent) }` line should be removed so currentColor inheritance actually works.

**Evidence:**

```
Sparkline.tsx:20-22 vs Sparkline.module.scss:1-5; comment promises tone-inheritance but the rule hardcodes the colour.
```

#### 11. `apps/web/index.html:5` — hardcoded-color

The inline-SVG favicon duplicates the dark-scheme `--accent` token value as a literal `stroke='%235b9dff'`. CSS custom properties cannot be referenced inside a `data:` URL favicon, so this is structurally unavoidable — but it is a second source of truth that will silently rot if the dark `--accent` token ever changes. Worth a comment pointing future maintainers at `_tokens.scss:30`.

**Evidence:**

```
apps/web/index.html line 5: `stroke='%235b9dff'` mirrors the value declared at apps/web/src/styles/_tokens.scss:30 `--accent: #5b9dff;`.
```

#### 12. `apps/web/src/components/QuotaGauge.module.scss:53` — dead-style

`.figure` uses `@include tabular-figures;` which sets `font-family: var(--font-mono)` plus `font-variant-numeric: tabular-nums`. Inside `.figure` the value rendered is `formatPercent(...)`-style text that is two short characters wide — a monospace font applied to a percentage label is the wrong typeface (proportional figures in the body sans-serif read more cleanly), and the `font-variant-numeric` rule has no effect on characters that aren't digits. The token is being applied where the type system never expected it.

**Evidence:**

```
QuotaGauge.module.scss:53-61 `.figure { @include tabular-figures; ... min-width: 3.25ch; font-size: var(--text-xs); color: var(--text-muted); text-align: right; }` — the rendered value is the small "62%" / "—" string shown in QuotaGauge.tsx:73, where monospace would be visually heavier than its neighbours in the row.
```

## Suggested next steps

1. **Fix the 8 high-severity findings in one worktree PR.** They are mechanical and small.
2. **Medium (8) and low (12) can ride a second PR** or stay as backlog.
3. **Live browser pass is owed.** Static review cannot catch interaction bugs,
   hydration mismatches, or real mobile rendering. Run the SPA end-to-end with
   the dev tooling and add to this list.

## Reproducibility

- Date: 2026-07-30
- Model: `MiniMax-M3[1m]`
- Pattern: 5 parallel `general-purpose` agents via the `Workflow` tool
- Source: `/tmp/claude-1003/-home-ivann-ws-developerz-ai-Projects-multi-ai-router/5d2b6df8-1cc7-4e33-a200-d4a5124401d4/tasks/wjana3g9k.output`
- Repo state at time of review: `main @ 2f02eb9` (clean)
