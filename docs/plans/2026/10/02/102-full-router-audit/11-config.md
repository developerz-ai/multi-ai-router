# 11 — Config, boot and distribution

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `packages/core/`, `apps/api/src/config/`, `apps/api/src/main.ts`, `apps/api/src/app.ts`, root build/container manifests, `bin/`, `.github/workflows/`. Documentation amendments below are coordinated through the overview.

## Findings

### 11.1 medium — Numeric environment values can overflow into immediate timers or infinite cache lifetimes

- **Where:** `apps/api/src/config/fields.ts:25`; consumers in `apps/api/src/config/env.ts:679`, `apps/api/src/composition/index.ts:216`, `apps/api/src/services/catalog/store.ts:75`.
- **Defect:** Digit-only strings are converted to numbers without finite/safe-integer checks or consumer-specific upper bounds, so accepted configuration can have entirely different runtime semantics.
- **Failure scenario:** Set `CATALOG_REFRESH_SECONDS=2592000` for a 30-day interval → milliseconds exceed a signed 32-bit timer → Bun schedules approximately every millisecond instead of every month, repeatedly refreshing the catalog, model store and price book. Set `KEY_CACHE_TTL_SECONDS` to a 400-digit value → parses to `Infinity`, eliminating the promised staleness bound. `PORT=65536` also passes parsing and fails later at the listener.
- **Evidence:** Pure `parseEnv` calls accepted `PORT=65536`, `UPSTREAM_TIMEOUT_MS=2147483648`, and a 400-digit `KEY_CACHE_TTL_SECONDS` as `Infinity`; Bun 1.4.0 `setTimeout(..., 2147483648)._idleTimeout` was `1` with `TimeoutOverflowWarning`. No provider or database contacted.
- **Fix:** Require safe finite integers in the shared numeric parser; enforce `0..65535` for ports and explicit maxima for numeric consumers. For timer-backed values, validate the converted milliseconds including positive jitter, or use a bounded long-delay scheduling primitive. Preserve documented zero exceptions. Document limits in `docs/idea/09-deployment.md`.
- **Test:** Failure first: `parseEnv` rejects the listed values by variable name; valid maximum ports, maximum timer values, numeric defaults and legal zeros still pass. Pure table tests cover seconds/minutes-to-milliseconds and jitter conversion without waiting on a real timer.

### 11.2 medium — OIDC boot validation accepts malformed URLs and scopes without `openid`

- **Where:** `apps/api/src/config/env.ts:705`, `apps/api/src/config/env.ts:884`.
- **Defect:** OIDC fields are checked for presence only; issuer/redirect URL syntax and the mandatory `openid` scope are never validated at boot.
- **Failure scenario:** Set all four required OIDC fields but use `ADMIN_OIDC_ISSUER_URL=not-a-url` and `ADMIN_OIDC_REDIRECT_URI=also-not-a-url` → the router considers OIDC configured, can pass the no-local-password boot check, then cannot complete any sign-in. With valid URLs and `ADMIN_OIDC_SCOPES=profile email`, a conforming provider does not return the required OIDC ID token and every completion fails.
- **Evidence:** A pure `parseEnv` call returned non-null `adminOidc` containing both malformed URLs and `scopes: ["profile", "email"]`. `apps/api/src/services/admin-auth/oidc/flow.ts:108` constructs the discovery fetch from that issuer; it does not repair the scope list.
- **Fix:** Validate issuer and redirect as absolute HTTP(S) URLs under the documented local-development policy; require `openid` in explicit scope lists. Preserve the all-absent local-login mode and current normalized email allowlist. Fail with variable names and no secret values. Update `docs/idea/13-admin-oidc.md` and `docs/idea/09-deployment.md`.
- **Test:** Failure first: malformed issuer, malformed redirect, non-HTTP scheme and an explicit list missing `openid` produce `EnvValidationError` naming the corresponding variable. Defaults, explicit `openid`, valid local redirect and local-only configuration pass.

### 11.3 low — Documented RC promotion cannot pass the release version guard

- **Where:** `docs/RELEASING.md:153`; enforcing code `bin/verify-version:37` and `.github/workflows/release.yml:74`.
- **Defect:** The promotion guide instructs operators to tag the unchanged RC commit with a stable version although the mandatory guard requires the tag to equal the RC-suffixed source version.
- **Failure scenario:** Release `v3.0.0-rc.1` with source/manifests at `3.0.0-rc.1`, then follow the guide by tagging the same commit `v3.0.0` → `bin/verify-version` rejects the stable tag before an image is published.
- **Fix:** Require a reviewed stable version/manifest/OCI-label/changelog update even when application code is unchanged, then run the existing verification and quality gates before tagging that commit. Remove the accompanying unchanged-digest promise; the version and build revision change artifact inputs. Keep the guard strict. Align `docs/idea/09-deployment.md` if promotion is described there.
- **Test:** Existing version-guard tests remain green; manually check the revised example has source version equal to the tag at each step. No new test needed for prose alone.

## Steps

1. Add boundary tests and tighten the shared numeric vocabulary and field-specific validation.
2. Add OIDC configuration tests; enforce URL and scope constraints without adding network work to boot parsing.
3. Correct the RC promotion guide and coordinate the documented config ranges with affected consumers.

## Tests

- Audit run: core/env/web unit suites, DATABASE_URL explicitly blank — **747 passed, 0 failed, 58 files**, Bun 1.4.0. This includes the web slice; do not add the counts twice.
- Executor: `bin/test packages/core/test/unit apps/api/test/unit/env.test.ts`; `bunx biome check <changed files>`.
- Coordinator runs `bin/lint (includes typecheck)` and `bin/check` once with an isolated test `DATABASE_URL`. No production database or live provider is a test target.

## Documentation claims falsified

- `docs/idea/09-deployment.md:108`: `openid` is mandatory, but parser accepts a scope list without it.
- `docs/idea/09-deployment.md:655`: a configured finite TTL is described as the replica staleness bound; accepted overflow can make it infinite.
- `docs/RELEASING.md:153`: unchanged RC commit can be promoted by a stable tag; version guard rejects it.
- No obsolete SQLite/`DATABASE_PATH` claim found in `docs/idea/` during this slice.

## Prior work and not covered

- Reviewed recent history for core/web/build files and `gh issue list --state all --search 'web OR config OR deployment'`; inspected closed web audit #57 and open secret incident #87. The tracked password in #87 remains present at HEAD; auth owns that finding, excluded here.
- Read core domain/errors/IDs/scrubbing, environment schema, boot/listener/app mounts, Dockerfile/compose/ignore rules, CI/release and bin wrappers. No image build/publish, live OIDC discovery, credential rotation, destructive dev setup or production query executed.
- Existing local runtime is Bun 1.4.0; Docker/CI pin 1.4.2. Executor repeats boundary verification on the pinned runtime. Release automation relies on the documented pre-tag quality gate; no release was exercised.
- DB pool/advisory-lock sizing and shutdown persistence behavior belong to coordinator-owned DB/scheduler slices.

## Done when

- Invalid numeric values cannot silently alter timer or cache semantics; errors identify the offending setting.
- OIDC-only deployments reject syntactically unusable login settings before opening the listener.
- RC promotion instructions satisfy the unchanged strict version guard.
