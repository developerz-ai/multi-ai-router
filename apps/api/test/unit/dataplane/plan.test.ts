import { describe, expect, test } from "bun:test"
import type { RoutableAccount } from "../../../src/services/dataplane"
import { planCandidates } from "../../../src/services/dataplane"
import type { Candidate } from "../../../src/services/routing"
import { account, catalog, subscriptionAccount } from "./fixtures"

/**
 * The plan's own estimate flag, pinned.
 *
 * `planCandidates` drops a Claude subscription asked to count — the Agent SDK states no token-count
 * call, so there is no upstream to address — and records that the scope could be answered by the
 * router's own labelled estimate instead. That record is a public surface the refusal path reads,
 * and it is computed by a comparison of two counters (`estimated === asked`) that no other test
 * looks at. A bug in it — a scope with an OpenAI account beside the subscriptions marked
 * estimable, or a subscription-only scope marked not estimable — would change what the client is
 * told, and would pass every other suite in the repository.
 *
 * Pure: no clock, no store, no network. The plan is a function of the candidates, the catalog and
 * the operation.
 */

/** A candidate, as routing hands one over: the account's snapshot plus its position in the chain. */
function candidate(snapshot: RoutableAccount["snapshot"], order = 0): Candidate {
  return {
    account: snapshot,
    poolId: null,
    weight: snapshot.weight,
    priority: snapshot.priority,
    order,
    upstreamModel: "claude-opus-5",
    halfOpen: false,
  }
}

/** The plan over one candidate, for one operation. */
function planOf(accounts: readonly RoutableAccount[], operation: "count-tokens" | "messages") {
  const candidates = accounts.map((one, order) => candidate(one.snapshot, order))
  return planCandidates(candidates, catalog(accounts), "anthropic", operation)
}

describe("the estimable flag", () => {
  test("a scope of nothing but Claude subscriptions is estimable, and nothing to attempt", () => {
    const plan = planOf([subscriptionAccount("sub")], "count-tokens")

    // Nothing in the chain: a subscription cannot be asked for a count, so there is no URL and no
    // subprocess to spend.
    expect(plan.servable).toHaveLength(0)
    // And the scope is answerable by the router's own labelled estimate.
    expect(plan.estimable).toBe(true)
  })

  test("a subscription beside an OpenAI account is not estimable", () => {
    // The scope is not one of subscriptions, so there is a provider-shaped gap in it. An estimate
    // here would hide that gap behind a plausible number.
    const plan = planOf(
      [subscriptionAccount("sub"), account("oai", { provider: "openai-api" })],
      "count-tokens",
    )

    expect(plan.estimable).toBe(false)
    // And the gap is named, so the refusal can say what is missing.
    expect(plan.rejection?.reason).toBe("unsupported-operation")
  })

  test("an Anthropic-dialect account beside a subscription is not estimable either", () => {
    // That account can count, so the request is answered by the provider's own number and the
    // estimate is never reached.
    const plan = planOf([subscriptionAccount("sub"), account("anth")], "count-tokens")

    expect(plan.estimable).toBe(false)
    expect(plan.servable).toHaveLength(1)
    expect(plan.servable[0]?.kind).toBe("http")
  })

  test("a scope of nothing but Claude subscriptions is estimable however many it holds", () => {
    const plan = planOf(
      [subscriptionAccount("sub-a"), subscriptionAccount("sub-b"), subscriptionAccount("sub-c")],
      "count-tokens",
    )

    expect(plan.estimable).toBe(true)
    expect(plan.servable).toHaveLength(0)
  })

  test("an OpenAI-only scope is not estimable", () => {
    const plan = planOf([account("oai", { provider: "openai-api" })], "count-tokens")

    expect(plan.estimable).toBe(false)
    expect(plan.servable).toHaveLength(0)
  })
})

describe("the flag is about counting only", () => {
  test("an inference plan over subscriptions is not estimable", () => {
    // A subscription serves inference perfectly well through the SDK, so nothing is missing and
    // there is nothing to estimate. The flag belongs to the count operation alone.
    const plan = planOf([subscriptionAccount("sub")], "messages")

    expect(plan.estimable).toBe(false)
    expect(plan.servable).toHaveLength(1)
    expect(plan.servable[0]?.kind).toBe("sdk")
  })
})
