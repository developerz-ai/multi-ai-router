import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { VERSION } from "@multi-ai-router/core"
import type { ErrorEvent } from "@sentry/bun"
import { z } from "zod"
import { REDACTED } from "../../src/logging/redact"

const fixture = fileURLToPath(new URL("../support/sentry-transport.ts", import.meta.url))
const resultSchema = z.object({
  bodies: z.array(z.string()),
  logs: z.array(z.string()),
  transports: z.number(),
  clientPresent: z.boolean(),
  flushed: z.boolean(),
  secrets: z.array(z.string()),
  fetchUnchanged: z.boolean(),
  serveUnchanged: z.boolean(),
  receivedHeaders: z.record(z.string(), z.string()),
  options: z
    .object({
      integrations: z.array(z.string()),
      tracesSampleRate: z.number(),
      traceLifecycle: z.string(),
      sendClientReports: z.boolean(),
      enableOpenTelemetrySetup: z.boolean(),
      enableRuntimeChannelInjection: z.boolean(),
      tracePropagationTargets: z.array(z.string()),
      dataCollection: z.record(z.string(), z.unknown()),
    })
    .nullable(),
})

async function run(scenario: "enabled" | "absent" | "invalid") {
  const child = Bun.spawn([process.execPath, "--no-env-file", fixture, scenario], {
    // No inherited DSN, Spotlight endpoint or preloads can turn this into a real service event.
    env: {
      PATH: process.env.PATH ?? "",
      SENTRY_TRACES_SAMPLE_RATE: "1",
      SENTRY_TRACE_LIFECYCLE: "stream",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  return resultSchema.parse(JSON.parse(stdout))
}

function eventOf(body: string): ErrorEvent {
  const lines = body.split("\n")
  const itemHeader = z.object({ type: z.literal("event") }).parse(JSON.parse(lines[1] ?? "null"))
  expect(itemHeader.type).toBe("event")
  return JSON.parse(lines[2] ?? "null") as ErrorEvent
}

describe("real Sentry SDK transport privacy", () => {
  test("redacts serialized envelopes, preserves stacks and avoids request instrumentation", async () => {
    const result = await run("enabled")
    expect(result.flushed).toBe(true)
    expect(result.transports).toBe(1)
    expect(result.bodies).toHaveLength(2)
    const serialized = result.bodies.join("\n")
    for (const secret of result.secrets) expect(serialized).not.toContain(secret)
    expect(serialized).toContain("req-privacy")
    expect(serialized).toContain("breadcrumb-safe")
    expect(result.fetchUnchanged).toBe(true)
    expect(result.serveUnchanged).toBe(true)
    expect(result.receivedHeaders["sentry-trace"]).toBeUndefined()
    expect(result.receivedHeaders.baggage).toBeUndefined()

    const events = result.bodies.map(eventOf)
    for (const event of events) {
      expect(event.release).toBe(VERSION)
      expect(event.environment).toBe("privacy-test")
      expect(event.tags?.router_revision).toBe("test-revision")
      expect(event.breadcrumbs?.some((crumb) => crumb.type === "http")).toBe(false)
    }
    const real = events.find((event) =>
      event.exception?.values?.some((value) => value.type === "Error"),
    )
    const frames = real?.exception?.values?.flatMap((value) => value.stacktrace?.frames ?? [])
    expect(
      frames?.some(
        (frame) => typeof frame.filename === "string" && typeof frame.lineno === "number",
      ),
    ).toBe(true)
    expect(real?.exception?.values?.some((value) => value.value === REDACTED)).toBe(true)
    const manual = events.find(
      (event) => event.exception?.values?.[0]?.type === "ManualFixtureError",
    )
    expect(manual?.exception?.values?.[0]?.stacktrace?.frames?.[0]).toMatchObject({
      filename: "privacy-fixture.ts",
      function: "safeDispatch",
      lineno: 42,
      colno: 7,
      vars: { apiKey: REDACTED, requestId: "req-manual" },
    })
    expect(manual?.request?.headers).toEqual({ authorization: REDACTED, cookie: REDACTED })
    expect(result.options).toEqual({
      integrations: [
        "Context",
        "Dedupe",
        "EventFilters",
        "FunctionToString",
        "LinkedErrors",
        "Modules",
        "OnUncaughtException",
        "OnUnhandledRejection",
      ],
      tracesSampleRate: 0,
      traceLifecycle: "static",
      sendClientReports: false,
      enableOpenTelemetrySetup: false,
      enableRuntimeChannelInjection: false,
      tracePropagationTargets: [],
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      },
    })
  }, 15_000)

  test("an absent DSN leaves the SDK and transport inert", async () => {
    const result = await run("absent")
    expect(result.clientPresent).toBe(false)
    expect(result.transports).toBe(0)
    expect(result.bodies).toEqual([])
    expect(result.logs).toEqual([])
    expect(result.options).toBeNull()
  }, 15_000)

  test("a malformed DSN warns without using a transport", async () => {
    const result = await run("invalid")
    expect(result.transports).toBe(0)
    expect(result.bodies).toEqual([])
    expect(result.logs).toHaveLength(1)
    expect(result.logs[0]).toContain("SENTRY_DSN was rejected by the SDK")
  }, 15_000)
})
