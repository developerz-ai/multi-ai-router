import { expect, test } from "bun:test"
import { updateAccountBody } from "../../../src/services/accounts/schemas"

const accepts = (baseUrl: string) => updateAccountBody.safeParse({ baseUrl }).success

test("a base URL with a NUL is refused: URL parsing hides it and the column cannot hold it", () => {
  expect(accepts("https://a.test/v1")).toBe(true)
  expect(accepts("https://a.test/v\u00001")).toBe(false)
  expect(accepts("https://a.test/v1\u0000")).toBe(false)
  expect(accepts("\u0000https://a.test/v1")).toBe(false)
})
