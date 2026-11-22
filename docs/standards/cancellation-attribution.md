# Cancellation attribution

A cancellation row is a statement about **who stopped the request**, not about the last stream that
happened to close. This page records the wiring that decides it, what the current repair changes,
and the rule every relay must keep.

## Evidenced code facts

Verified in this checkout against the repaired tree:

- **The relay signal carries two reasons, and a deadline is not one of them.**
  `apps/api/src/services/dataplane/chain-relay.ts:176-179` builds `relaySignal` as `AbortSignal.any`
  of two signals only, `ctx.request.signal` and `lease.signal` (`:175` settles a lease already
  aborted before it). `ctx.request.signal` is composed at
  `apps/api/src/services/dataplane/request-lifetime.ts:45-50`, again `AbortSignal.any` of the
  inbound request signal and that same lease signal. The lease aborts with exactly one value,
  `new RouterShutdownError()` (`apps/api/src/services/dataplane/active-requests.ts:44`). So the only
  reasons that can arrive on the signal a relay observes are whatever the inbound side supplies
  (a client abort, or the runtime reaping a vanished peer) and a router shutdown. The upstream
  deadline's `TimeoutError` is aborted on its **own** controller and never joins this composition,
  so it cannot arrive through it; the next bullet is where it does land.
- **A deadline fails the watched body instead.**
  `apps/api/src/services/dataplane/upstream-deadline.ts:101-114` aborts its **own** controller with
  a `TimeoutError` (`:109-110`) and then errors the watched upstream body (`:113`). That rejection
  surfaces through the `pipeTo` catch at `apps/api/src/services/dataplane/relay.ts:83-85`
  (translated sibling at `relay-translate.ts:273-275`) and is classified `upstream_timeout` at
  `apps/api/src/services/dataplane/relay-terminal.ts:99-103`. Deadline mislabelling is therefore
  **refuted** as a cause here; do not reintroduce it as the explanation.
- **The settle that wins an aborted signal is `chain-relay.ts:88-89`.** `requestAborted` is
  registered at `:171` and invoked at `:172` when the signal is already aborted, before the relay
  exists, and `settle` returns at its `if (settled) return` guard (`:91`) for every later caller.
  The relays' own cancellation callbacks (`relay.ts:94`, `relay-translate.ts:280`,
  `relay-translate-body.ts:106-114`) are shadowed whenever the signal aborted first. Before the
  repair this settle tested one class, `reason instanceof RouterShutdownError`, and filed every
  other reason as `new ClientCancelledError()`. That one-branch test is the defect: a router-caused
  reason that was not a shutdown was recorded as a client cancellation.
- **The repair classifies from the reason, in one place.**
  `apps/api/src/services/dataplane/relay-cancellation.ts:21-28` exports `cancellationError(reason)`
  and `relayCancellationError(signal)`: a real error whose `name` is not `"AbortError"` is kept as
  the settlement error, and only an `AbortError` (or no reason) becomes a `ClientCancelledError`.
  `chain-relay.ts:89` (the bare reason a listener already holds), `relay.ts:94`,
  `relay-translate.ts:280` and `relay-translate-body.ts:111` all settle through it, so no cancel
  callback constructs `ClientCancelledError` unconditionally. `isRouterAbort` stays private to that
  module (`relay-cancellation.ts:38-40`): a second copy of the `instanceof Error` /
  `name !== "AbortError"` test is the regression.
- **A genuine client abort must stay a cancellation.** A downstream disconnect arrives as a
  `DOMException` named `AbortError`; the helper maps it to `ClientCancelledError`, and
  `apps/api/src/services/dataplane/relay-terminal.ts:91-97` records `client_error` /
  `client_cancelled`. A `RouterShutdownError` is its own `router_shutdown` verdict (`:84-90`), and
  `:98-103` files every remaining error as `upstream_timeout` (by `name === "TimeoutError"`) or
  `upstream_error`. Narrowing or widening either test changes who is blamed.
- `apps/api/src/services/dataplane/request-accounting.ts:54-59` maps `client_cancelled` (and
  `router_shutdown`) to terminal `attributionKind: "abandoned"`. That is the machine-unclaimed
  fingerprint: no client evidence, no upstream status, an account that did nothing wrong. The
  accounting rule is **not** changed by this repair; the classification upstream of it is.
- **`request-lifetime.ts:78-82` is client-scoped, not this class.** `fail()` replaces an error equal
  to the reason of `input.request.signal` with `new ClientCancelledError()`, and `input` is the
  closure's original input: `request-lifetime.ts:45-50` composes the lease signal onto a
  **separate** `Request` and leaves `input.request` untouched (the composed one is handed on at
  `:52`). So neither the lease's `RouterShutdownError` nor any reason a relay observes arrives on
  the signal this tests, and a router cause is not mislabelled there today. What does arrive is
  whatever aborted the inbound request downstream of the router, which is the client's column: a
  caller disconnect, or the listener reaping a vanished peer. (The two cases where that reap was
  itself the bug are fixed at `idleClock.ts`, below, not here.)
  `apps/api/test/unit/dataplane/caller-cancellation.test.ts:66-80` pins the client reading, with a
  plain `Error` as the caller's reason settling `client_cancelled` / `499`. The line stops being
  right the moment a router cause is wired onto the inbound signal: then it must classify through
  `cancellationError` like every other settle. This repair does not touch it, and this page does
  not promise otherwise.
- The relay path in `apps/api/test/unit/dataplane/router-abort-classification.test.ts` asserts both
  directions: the shared classification is unit-tested from a bare reason (`:25-48`), a router abort
  at the relay keeps its real error (`:51-80`) while a named `AbortError` still settles
  `ClientCancelledError` (`:82-106`), bytes stay passthrough throughout (`:108-127`), and the
  winning chain settle records a non-shutdown router reason as itself rather than
  `client_cancelled` (`:193-204`), with a bare client abort still `client_cancelled` (`:206-216`).
  The chain settle is asserted by driving `createDispatcher` and reading the `UsageRecord` rows
  (`outcome` / `errorClass`): the listener at `chain-relay.ts:171` settles first, so no relay-level
  test can observe which classification won.
- Two earlier router-caused `client_cancelled` paths, both from the listener's idle clock, are fixed
  and tested separately: a non-streamed answer cut after `SERVER_IDLE_TIMEOUT_SECONDS`
  (`apps/api/src/middleware/idleClock.ts:6-14`, `CHANGELOG.md:694`) and a silent upstream event
  stream before its first byte (`idleClock.ts:19-25`, `CHANGELOG.md:299`), exercised at
  `apps/api/test/integration/idle-clock.test.ts:49` and `:169`. Neither is the cause addressed in
  this page.

## Production fingerprint

Read-only production query, gateway `d1`, server `worker-db`, database `multi_ai_router`, seven-day
window: **285** terminal `client_cancelled` rows, **282** `abandoned` and 3 `unstarted`. By egress
mode the 285 split **162** translated (`translate`, all on openai-oauth upstreams), **104**
`passthrough` (all on openrouter), **16** `agent-sdk`, and 3 with no usage row at all (the
`unstarted` terminals). No translated request is on openrouter: that provider is passthrough-only,
so any claim of "translated openrouter" rows is stale. The 282 abandoned rows run `p50` 28 s, `p95`
303 s, max 634 s. Most carry `response_status` 200 and none has a null `response_status`; 33 carry a
null `http_status`, which is the column that means "we never reached the upstream".

The census carries no field distinguishing a router abort from a client hang-up, so this fingerprint
alone cannot separate the two. Those durations are equally consistent with a router-side bound and
with ordinary client-side timeouts, and both populations produce the same row shape.

## Hypothesis, not an evidenced production finding

HYPOTHESIS: part of the machine-unclaimed count came from the one-branch settle at
`chain-relay.ts:88-89`, where a router-caused reason that was not a shutdown became
`client_cancelled`, and accounting marked it `abandoned`. What is refuted is the earlier reading
that a deadline `TimeoutError` reaches the relay signal: the wiring above rules it out, and
deadlines were already recorded as `upstream_timeout`.

The repair closes the classification gap. It is **not** claimed to have caused a measured seven-day
change: nothing read for this page attributes the 282 rows to it, and genuine client disconnects
produce the same shape. Do not present the hypothesis as a measured regression or restate it as a
verified production cause.

## Preventive rule

**Classify from the abort reason, never from the fact that an abort happened.** `instanceof` one
class is not a classification: a settle that tests a single reason and files the rest under a
default records the default, not the cause. Read `signal.reason`, and let one shared helper own the
`AbortError` test so the client/router boundary is defined in one file.

**Never attribute a router-initiated abort to the client.** A relay settles the row with the real
error class of the abort (`upstream_timeout` for a deadline, `router_shutdown` for a lease), and
only a verified client disconnect settles `client_cancelled`. Byte passthrough and stream semantics
are untouched by the classification: it lives in the settle callback, not in the bytes forwarded.
Never hide a cancellation to make a metric look better, and never relabel an abandoned terminal
downstream; fix it at its source.

**Assert both directions.** When adding or changing an abort path, assert that a router-caused
reason records its own error class, **and** that a real client disconnect still records
`client_cancelled`. A test covering only the client side cannot fail when the router side is
swallowed; a test covering only the router side cannot fail when cancellations are hidden.