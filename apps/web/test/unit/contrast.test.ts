import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The palette's own claim, computed: text clears 4.5:1 on every surface *and* on the tints the
 * console composes at runtime (a danger banner, a selected segment), and a control's edge clears
 * the 3:1 WCAG asks of anything you have to find to use. Read from the stylesheet, so a token
 * changed by eye fails here.
 */

type Rgb = readonly [number, number, number]

const SOURCE = readFileSync(join(import.meta.dir, "../../src/styles/_tokens.scss"), "utf8")

function scheme(name: "dark" | "light") {
  const body = SOURCE.split(`@mixin ${name}-tokens {`)[1]?.split("\n}")[0] ?? ""
  const tokens = new Map([...body.matchAll(/--([\w-]+): ([^;]+);/g)].map((m) => [m[1], m[2]]))
  const hex = (token: string): Rgb => {
    const value = tokens.get(token) ?? ""
    if (!/^#[0-9a-f]{6}$/.test(value)) throw new Error(`--${token} is not a hex colour: ${value}`)
    return [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16)) as unknown as Rgb
  }
  const soft = /rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/.exec(tokens.get("accent-soft") ?? "")
  if (soft === null) throw new Error("--accent-soft is not an rgb() with alpha")
  const [r, g, b, alpha] = soft.slice(1).map(Number) as [number, number, number, number]
  return { hex, soft: { color: [r, g, b] as Rgb, alpha } }
}

const mix = (top: Rgb, under: Rgb, alpha: number): Rgb =>
  top.map((channel, at) => channel * alpha + (under[at] ?? 0) * (1 - alpha)) as unknown as Rgb

function luminance(color: Rgb): number {
  const [r, g, b] = color.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }) as unknown as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

const SURFACES = ["surface", "surface-raised", "surface-overlay", "surface-sunken"] as const
const TEXT = ["text", "text-muted", "accent", "ok", "warn", "danger"] as const

for (const name of ["dark", "light"] as const) {
  const { hex, soft } = scheme(name)
  const failures: string[] = []
  const check = (what: string, value: number, floor: number) => {
    if (value < floor) failures.push(`${what} ${value.toFixed(2)} < ${floor}`)
  }

  test(`${name}: every text token clears 4.5:1 on every surface and tint it sits on`, () => {
    for (const surface of SURFACES) {
      for (const token of TEXT)
        check(`${token} on ${surface}`, ratio(hex(token), hex(surface)), 4.5)
      check(
        `accent on accent-soft over ${surface}`,
        ratio(hex("accent"), mix(soft.color, hex(surface), soft.alpha)),
        4.5,
      )
    }
    // Banners and refusals: the tone at 10 % over the surface, carrying its own title, body text
    // and a link.
    for (const tone of ["danger", "warn"] as const) {
      for (const surface of ["surface-raised", "surface-overlay"] as const) {
        const tint = mix(hex(tone), hex(surface), 0.1)
        for (const token of ["text", "text-muted", "accent", tone] as const) {
          check(`${token} on ${tone} tint over ${surface}`, ratio(hex(token), tint), 4.5)
        }
      }
    }
    for (const fill of ["accent", "danger"] as const) {
      check(`accent-contrast on ${fill}`, ratio(hex("accent-contrast"), hex(fill)), 4.5)
    }
    expect(failures).toEqual([])
  })

  test(`${name}: a control's edge and the focus ring clear 3:1`, () => {
    const edges: string[] = []
    for (const surface of SURFACES) {
      for (const token of ["border-strong", "accent"]) {
        const value = ratio(hex(token), hex(surface))
        if (value < 3) edges.push(`${token} on ${surface} ${value.toFixed(2)}`)
      }
    }
    expect(edges).toEqual([])
  })

  test(`${name}: the soft accent is the accent`, () => {
    expect(soft.color).toEqual(hex("accent"))
  })
}
