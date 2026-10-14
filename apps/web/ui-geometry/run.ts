// bin/ui-geometry's engine: build the SPA, serve it from an in-process static
// server, drive it in pinned headless Chromium through the fixture's admin-API
// mocks, and assert the tables' geometry at three operator-typical widths.
//
// Determinism is the whole game (CLAUDE.md's testing bar, and the reason #94
// could pass CI green): pinned Playwright + pinned browser build, pinned fonts,
// deviceScaleFactor 1, pinned locale/timezone/color scheme, reduced motion, and
// a fixture whose data never changes. Anything env-dependent is either pinned
// here or fails the run.
import { type Browser, chromium } from "playwright"
import { installAdminMock } from "./admin-mock"
import { Checker, measure } from "./geometry"
import { assertAccounts, assertKeys, reportLine } from "./rules"
import { startStaticServer } from "./server"

/** The three widths the gate holds: compact laptop, common default, roomy desktop. */
const WIDTHS = [1024, 1280, 1440] as const
const HEIGHT = 900

/** Both stacks exist in `fonts-dejavu-core`; the gate fails if either is missing. */
const FONT_PIN = `
  :root {
    --font-sans: "DejaVu Sans", sans-serif !important;
    --font-mono: "DejaVu Sans Mono", monospace !important;
  }
`

/** One console surface to hold: which column carries cost, and what proves it rendered. */
interface Surface {
  readonly path: string
  readonly name: string
  readonly costHeaderPrefix: string
  readonly credentialHeader: string | null
  readonly ready: string
  readonly assert: typeof assertAccounts | typeof assertKeys
}

const SURFACES: readonly Surface[] = [
  {
    path: "/accounts",
    name: "accounts",
    costHeaderPrefix: "Usage ·",
    credentialHeader: "Credential / login",
    ready: '[class*="_figures_"]',
    assert: assertAccounts,
  },
  {
    path: "/keys",
    name: "keys",
    costHeaderPrefix: "Cost ·",
    credentialHeader: null,
    ready: '[class*="_spend_"]',
    assert: assertKeys,
  },
]

async function main(): Promise<number> {
  // This file is apps/web/ui-geometry/run.ts — the package root is one level up.
  const webDir = new URL("../", import.meta.url).pathname
  const build = Bun.spawnSync(["bun", "run", "build"], {
    cwd: webDir,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (build.exitCode !== 0) {
    console.error("ui-geometry: the SPA build failed — the gate never runs against a stale dist")
    return 1
  }

  const server = await startStaticServer(`${webDir}dist`)
  const checker = new Checker()
  const lines: string[] = []

  let browser: Browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    console.error(
      `ui-geometry: headless Chromium unavailable (${String(error)}). Run: bunx playwright install chromium`,
    )
    server.stop()
    return 1
  }

  try {
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width, height: HEIGHT },
        deviceScaleFactor: 1,
        colorScheme: "dark",
        reducedMotion: "reduce",
        locale: "en-US",
        timezoneId: "UTC",
      })
      const mock = installAdminMock(context, server.origin)
      const page = await context.newPage()

      for (const surface of SURFACES) {
        await page.goto(`${server.origin}${surface.path}`)
        await page.waitForSelector("table")
        await page.addStyleTag({ content: FONT_PIN })
        await page.evaluate(async () => {
          await document.fonts.ready
        })
        const fontsOk = await page.evaluate(
          () =>
            document.fonts.check('16px "DejaVu Sans"') &&
            document.fonts.check('16px "DejaVu Sans Mono"'),
        )
        checker.check(
          fontsOk,
          `${surface.name} @${width}: pinned fonts unavailable — install fonts-dejavu-core`,
        )
        // The ready selector only orders the measurement behind the usage query;
        // a timeout is not itself the failure; it is the zero-match rules in
        // rules.ts that must name the empty scope. Swallowing the timeout here
        // turns "selector matched nothing" into that named failure instead of an
        // opaque 30s stack.
        await page.waitForSelector(surface.ready, { timeout: 10_000 }).catch(() => undefined)
        const meas = await measure(page, {
          costHeaderPrefix: surface.costHeaderPrefix,
          credentialHeader: surface.credentialHeader,
        })
        const report = surface.assert(checker, meas)
        lines.push(reportLine(surface.name, width, report))
      }

      for (const violation of mock.violations()) {
        checker.check(false, `@${width}px egress fence: ${violation}`)
      }
      await context.close()
    }
  } finally {
    await browser.close()
    server.stop()
  }

  console.log("ui-geometry: measured numbers (for the PR body)")
  for (const line of lines) console.log(`  ${line}`)
  const failures = checker.failures
  if (failures.length > 0) {
    console.error(`ui-geometry: FAIL — ${failures.length} broken, ${checker.passed} held`)
    for (const failure of failures) console.error(`  ✘ ${failure}`)
    return 1
  }
  console.log(`ui-geometry: PASS — ${checker.passed} checks held at ${WIDTHS.join("/")}px`)
  return 0
}

// Bun runs top-level await, but an explicit main keeps the exit code honest.
process.exitCode = await main()
