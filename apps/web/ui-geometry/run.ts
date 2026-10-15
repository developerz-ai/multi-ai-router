// bin/ui-geometry's engine: build the SPA, serve it from an in-process static
// server, drive it in pinned headless Chromium through the fixture's admin-API
// mocks, and assert the tables' geometry at three operator-typical widths.
//
// Determinism is the whole game (CLAUDE.md's testing bar, and the reason #94
// could pass CI green): pinned Playwright + pinned browser build, pinned fonts,
// deviceScaleFactor 1, pinned locale/timezone/color scheme, reduced motion, and
// a fixture whose data never changes. Anything env-dependent is either pinned
// here or fails the run.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, chromium } from "playwright"
import { installAdminMock } from "./admin-mock"
import { accounts, keys, NOW } from "./fixture"
import { Checker, measure, pinnedFontsInstalled } from "./geometry"
import { assertAccounts, assertKeys, reportLine } from "./rules"
import { startStaticServer } from "./server"
import { assertStress, type StressExpectation } from "./stress"

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
  readonly blockSelector: string
  readonly textSelector: string | null
  readonly assert: typeof assertAccounts | typeof assertKeys
  readonly stress: StressExpectation
}

const SURFACES: readonly Surface[] = [
  {
    path: "/accounts",
    name: "accounts",
    costHeaderPrefix: "Usage ·",
    credentialHeader: "Credential / login",
    ready: '[class*="_figures_"]',
    blockSelector: '[class*="_figures_"]',
    textSelector: '[class*="_spend_"]',
    assert: assertAccounts,
    stress: { rows: accounts.length, figures: [], storedRowNotZero: true },
  },
  {
    path: "/keys",
    name: "keys",
    costHeaderPrefix: "Cost ·",
    credentialHeader: null,
    ready: '[class*="_spend_"]',
    blockSelector: '[class*="_spend_"]',
    textSelector: null,
    assert: assertKeys,
    stress: {
      rows: keys.length,
      figures: [{ label: "big-spender Keys cost", text: "$45,679" }],
      storedRowNotZero: false,
    },
  },
]

async function main(): Promise<number> {
  // This file is apps/web/ui-geometry/run.ts — the package root is one level up.
  const webDir = new URL("../", import.meta.url).pathname
  // Built into a throwaway dir so a gate run never overwrites the apps/web/dist
  // an operator (or bin/dev) may be serving.
  const outDir = await mkdtemp(join(tmpdir(), "ui-geometry-dist-"))
  const build = Bun.spawnSync(["bun", "run", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: webDir,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (build.exitCode !== 0) {
    console.error("ui-geometry: the SPA build failed — the gate never runs against a stale dist")
    await rm(outDir, { recursive: true, force: true })
    return 1
  }

  const server = await startStaticServer(outDir)
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
    await rm(outDir, { recursive: true, force: true })
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
      // The SPA reads Date.now via lib/clock.ts; unpinned, renewal and relative
      // dates drift from the fixture and the layout with them.
      await context.clock.setFixedTime(NOW)
      const mock = await installAdminMock(context, server.origin)
      const page = await context.newPage()

      for (const surface of SURFACES) {
        // A table that never renders is a named failure for this surface and
        // width, not a thrown timeout that skips the egress report below.
        const rendered = await page
          .goto(`${server.origin}${surface.path}`)
          .then(() => page.waitForSelector("table", { timeout: 30_000 }))
          .then(() => true)
          .catch(() => false)
        if (!rendered) {
          checker.check(
            false,
            `${surface.name} @${width}: no <table> rendered within 30s — the page errored, the route moved, or an admin call was unmocked`,
          )
          continue
        }
        await page.addStyleTag({ content: FONT_PIN })
        await page.evaluate(async () => {
          await document.fonts.ready
        })
        // document.fonts.check() answers true for a family that does not exist,
        // so the pin is proven by rendered width instead (see geometry.ts).
        checker.check(
          await pinnedFontsInstalled(page),
          `${surface.name} @${width}: pinned fonts unavailable — install fonts-dejavu-core`,
        )
        // The ready selector orders the measurement behind the usage query. A
        // miss is a NAMED failure (the selector drifted or the query never
        // resolved), not a swallowed timeout; measurement still runs so the
        // zero-match rules in rules.ts add their own sentences.
        await page.waitForSelector(surface.ready, { timeout: 10_000 }).catch(() => {
          checker.check(
            false,
            `${surface.name} @${width}: ready selector ${surface.ready} never matched in 10s — a cost-block class was renamed or the usage query never resolved`,
          )
        })
        const meas = await measure(page, {
          costHeaderPrefix: surface.costHeaderPrefix,
          credentialHeader: surface.credentialHeader,
          blockSelector: surface.blockSelector,
          textSelector: surface.textSelector,
        })
        const report = surface.assert(checker, meas)
        assertStress(checker, `${surface.name} @${width}`, meas, surface.stress)
        lines.push(reportLine(surface.name, width, report))
      }

      // Reported even when a surface failed to render: an unmocked call is often why.
      for (const violation of mock.violations()) {
        checker.check(false, `@${width}px egress fence: ${violation}`)
      }
      await context.close()
    }
  } finally {
    await browser.close()
    server.stop()
    await rm(outDir, { recursive: true, force: true })
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
