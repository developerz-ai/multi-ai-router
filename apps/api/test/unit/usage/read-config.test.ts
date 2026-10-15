import { expect, test } from "bun:test"
import { EnvValidationError, parseEnv } from "../../../src/config/env"

const base = {
  DATABASE_URL: "postgres://router:router@127.0.0.1:5440/router",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
}

test("usage presentation bounds have explicit defaults and honor both supported edges", () => {
  expect(parseEnv(base).usageRead).toEqual({
    maxChartPoints: 400,
    breakdownMaxRows: 100,
    exportMaxRows: 50_000,
  })
  expect(
    parseEnv({ ...base, USAGE_CHART_MAX_POINTS: "2", USAGE_BREAKDOWN_MAX_ROWS: "1" }).usageRead,
  ).toEqual({ maxChartPoints: 2, breakdownMaxRows: 1, exportMaxRows: 50_000 })
  expect(
    parseEnv({
      ...base,
      USAGE_CHART_MAX_POINTS: "2000",
      USAGE_BREAKDOWN_MAX_ROWS: "1000",
      USAGE_EXPORT_MAX_ROWS: "100000",
    }).usageRead,
  ).toEqual({ maxChartPoints: 2000, breakdownMaxRows: 1000, exportMaxRows: 100_000 })
  expect(parseEnv({ ...base, USAGE_EXPORT_MAX_ROWS: "1" }).usageRead.exportMaxRows).toBe(1)
})

test("out-of-domain usage limits fail boot rather than silently truncating", () => {
  for (const value of ["0", "1", "2001", "2.5"]) {
    expect(() => parseEnv({ ...base, USAGE_CHART_MAX_POINTS: value })).toThrow(EnvValidationError)
  }
  for (const value of ["0", "1001", "1.5"]) {
    expect(() => parseEnv({ ...base, USAGE_BREAKDOWN_MAX_ROWS: value })).toThrow(EnvValidationError)
  }
})

test("USAGE_EXPORT_MAX_ROWS outside 1..100000 or not an integer fails boot", () => {
  for (const value of ["0", "-5", "100001", "1.5", "lots"]) {
    expect(() => parseEnv({ ...base, USAGE_EXPORT_MAX_ROWS: value })).toThrow(EnvValidationError)
  }
})
