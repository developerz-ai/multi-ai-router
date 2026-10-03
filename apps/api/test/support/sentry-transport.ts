import * as Sentry from "@sentry/bun"
import { parseEnv } from "../../src/config/env"
import { createLogger } from "../../src/logging/logger"
import { captureException, initSentry } from "../../src/observability/sentry"

// SDK integrations and scopes are process-global; every scenario runs in a fresh subprocess.
const scenario = process.argv[2]
const bodies: string[] = []
const logs: string[] = []
let transports = 0
const env = parseEnv({
  DATABASE_URL: "postgres://router:router@localhost/router",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ROUTER_REVISION: "test-revision",
  SENTRY_ENVIRONMENT: "privacy-test",
  ...(scenario === "absent"
    ? {}
    : { SENTRY_DSN: scenario === "invalid" ? "invalid-dsn" : "https://public@example.invalid/1" }),
})
const transport: NonNullable<Sentry.BunOptions["transport"]> = (options) => {
  transports++
  return Sentry.createTransport(options, async (request) => {
    bodies.push(
      typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body),
    )
    return { statusCode: 200 }
  })
}
const originalFetch = globalThis.fetch
const originalServe = Bun.serve
initSentry(env, createLogger({ level: "debug", write: (line) => logs.push(line) }), transport)
const options = Sentry.getClient()?.getOptions()

const secrets = {
  api: "sk-ant-privacyapitoken",
  router: "mar_live_privacyroutertoken",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YWN5In0.privacysignature",
  bearer: "at-privacybearertoken",
  database: "privacydatabasepassword",
  callback: "privacycallbackcode",
  verifier: "privacyopaqueverifier",
  cookie: "privacyopaquecookie",
  authorization: "privacyopaqueauthorization",
  request: "privacyrequestbody",
  response: "privacyresponsebody",
  header: "privacyrequestheader",
  ai: "privacylogcontent",
  metric: "privacymetriccontent",
}
let receivedHeaders: Record<string, string> = {}
if (scenario === "enabled") {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      receivedHeaders = Object.fromEntries(request.headers.entries())
      await request.text()
      return new Response(secrets.response)
    },
  })
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "x-private-fixture": secrets.header },
      body: secrets.request,
    })
    await response.text()
  } finally {
    server.stop(true)
  }

  Sentry.addBreadcrumb({
    category: "privacy-fixture",
    message: `Authorization: Bearer ${secrets.bearer}`,
    data: { authorization: secrets.authorization, safe: "breadcrumb-safe" },
  })
  captureException(new Error("transport fixture", { cause: new Error(secrets.api) }), {
    tags: { path: "/v1/messages", note: secrets.api },
    extra: {
      requestId: "req-privacy",
      note: `${secrets.jwt} ${secrets.router}`,
      database: `postgres://router:${secrets.database}@localhost/router`,
      callback: `https://router.invalid/callback?code=${secrets.callback}`,
      authorization: secrets.authorization,
      cookie: secrets.cookie,
      code_verifier: secrets.verifier,
    },
  })
  // Explicit capture values bypass collection limits; beforeSend must still scrub them.
  Sentry.captureEvent({
    exception: {
      values: [
        {
          type: "ManualFixtureError",
          value: "manual transport fixture",
          stacktrace: {
            frames: [
              {
                filename: "privacy-fixture.ts",
                function: "safeDispatch",
                lineno: 42,
                colno: 7,
                vars: { apiKey: secrets.api, requestId: "req-manual" },
              },
            ],
          },
        },
      ],
    },
    request: {
      method: "POST",
      url: "https://router.invalid/v1/messages",
      headers: { authorization: secrets.authorization, cookie: secrets.cookie },
      data: `upstream quoted ${secrets.api}`,
    },
  })
  Sentry.logger.info(secrets.ai)
  Sentry.metrics.count("privacy-fixture", 1, { attributes: { note: secrets.metric } })
  Sentry.startSpan({ name: "privacy-fixture", op: "test" }, () => undefined)
} else {
  captureException(new Error("disabled fixture"))
}

const flushed = await Sentry.flush(2_000)
process.stdout.write(
  JSON.stringify({
    bodies,
    logs,
    transports,
    clientPresent: Sentry.getClient() !== undefined,
    flushed,
    secrets: Object.values(secrets),
    fetchUnchanged: originalFetch === globalThis.fetch,
    serveUnchanged: originalServe === Bun.serve,
    receivedHeaders,
    options: options
      ? {
          integrations: options.integrations.map((integration) => integration.name).sort(),
          tracesSampleRate: options.tracesSampleRate,
          traceLifecycle: options.traceLifecycle,
          sendClientReports: options.sendClientReports,
          enableOpenTelemetrySetup: options.enableOpenTelemetrySetup,
          enableRuntimeChannelInjection: options.enableRuntimeChannelInjection,
          tracePropagationTargets: options.tracePropagationTargets,
          dataCollection: options.dataCollection,
        }
      : null,
  }),
)
await Sentry.close(2_000)
