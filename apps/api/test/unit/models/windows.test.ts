import { describe, expect, test } from "bun:test"
import { ProviderId } from "@multi-ai-router/core"
import { lookupContextWindow } from "../../../src/services/models"

describe("shipped context window lookup", () => {
  for (const model of ["constructor", "toString", "__proto__", "constructor-2026-01-01"]) {
    test(`${model} cannot inherit a context row or a family row`, () => {
      for (const provider of ProviderId.options) {
        expect(lookupContextWindow(provider, model)).toBeNull()
      }
    })
  }
})
