import { expect, test } from "bun:test"
import { endpointMove } from "../../src/lib/endpoint-move"

const at = (baseUrl: string | null, dialect: string | null = null) => ({ baseUrl, dialect })

test("only another origin is a move; a path is not", () => {
  expect(endpointMove(at("https://a.example/v1"), at("https://a.example/v2/"))).toBe("same")
  expect(endpointMove(at("https://a.example/v1"), at(" HTTPS://A.example:443/v1 "))).toBe("same")
  expect(endpointMove(at("https://a.example"), at("https://b.example"))).toBe("moved")
  expect(endpointMove(at("https://a.example"), at("http://a.example"))).toBe("moved")
  expect(endpointMove(at(null), at(""))).toBe("same")
})

test("to or from the provider's own endpoint is not known here", () => {
  expect(endpointMove(at(null), at("https://b.example"))).toBe("unknown")
  expect(endpointMove(at("https://b.example"), at(""))).toBe("unknown")
})

test("a dialect picks which of the provider's own endpoints is used, and no other", () => {
  expect(endpointMove(at(null, null), at("", "anthropic"))).toBe("unknown")
  expect(endpointMove(at(null, "anthropic"), at(null, "anthropic"))).toBe("same")
  expect(endpointMove(at("https://a.example", null), at("https://a.example", "anthropic"))).toBe(
    "same",
  )
})

test("a half-typed address is not a move yet", () => {
  expect(endpointMove(at("https://a.example"), at("https:/"))).toBe("same")
})
