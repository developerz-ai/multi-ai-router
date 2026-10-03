import { describe, expect, test } from "bun:test"
import { ProviderId } from "@multi-ai-router/core"
import { lookupRates } from "../../../src/services/cost"

describe("shipped price lookup", () => {
  for (const model of ["constructor", "toString", "__proto__", "constructor-2026-01-01"]) {
    test(`${model} cannot inherit a price row or a family row`, () => {
      for (const provider of ProviderId.options) {
        expect(lookupRates(provider, model)).toBeNull()
      }
    })
  }
})
