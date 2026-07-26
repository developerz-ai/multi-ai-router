/**
 * Wires a real Solid render pipeline into `bun test` for component tests.
 * None of this exists for production — Vite + `vite-plugin-solid` own the
 * real build; this is a test-only shim so `apps/web/test/unit/**` can mount
 * an actual component instead of asserting on prop plumbing alone.
 *
 * Three problems, three fixes:
 *
 * 1. Bun's own JSX transform assumes React's automatic runtime. Solid
 *    compiles JSX to direct `createComponent`/`insert` calls via a Babel
 *    preset instead (the same one `vite-plugin-solid` runs at build time),
 *    so every `.tsx` file under this workspace is intercepted in `onLoad`
 *    and run through `babel-preset-solid` before Bun ever parses it.
 * 2. Bun resolves bare `solid-js`/`solid-js/web` imports to their *server*
 *    build under the "node" condition (no reactivity, no DOM writes —
 *    `Portal` alone renders as an empty string there, which would make a
 *    Modal-based dialog test pass on nothing rendered at all). `bun test`'s
 *    runtime loader doesn't run plugin `onResolve` for specifiers it can
 *    already resolve on its own (only `Bun.build` does), so instead of
 *    redirecting the *path* this hooks `onLoad` for the already-resolved
 *    `.../solid-js/dist/server.js` and `.../solid-js/web/dist/server.js`
 *    files and substitutes the sibling client ("dev") build's source —
 *    same resolved path, different contents, so real reactivity and real
 *    DOM mutation run.
 * 3. The client build needs a DOM. `@happy-dom/global-registrator` installs
 *    `document`/`window`/etc. as globals once per test file, registered
 *    before any component module is imported.
 * 4. Solid's compiled templates build a fragment with
 *    `document.createElement("template"); t.innerHTML = html; t.content`.
 *    Per the HTML spec, `<template>` content parses in the same "in
 *    template" insertion mode a real page uses, so a bare `<th>`/`<tr>`/
 *    `<td>` (no surrounding `<table>`) still becomes a real element there.
 *    happy-dom's parser doesn't implement that mode — it applies ordinary
 *    body-parsing table-foster-parenting rules even inside a `<template>`,
 *    so a template whose whole content is `<th scope=col>` silently parses
 *    to nothing (`t.content.firstChild` is `null`), and `Table.tsx` (used
 *    by `AccountsTable` and every other list screen) is exactly this
 *    shape. Patched by hooking `HTMLTemplateElement.prototype.innerHTML`:
 *    when the assigned markup's outermost tag is table-scoped, it is set
 *    on a real, detached `<table>` first — which happy-dom parses
 *    correctly, foster-parenting rules and all, because there the table
 *    context already exists — and the matching element is moved into the
 *    template's content fragment instead.
 *
 * `.module.scss` imports are stubbed to a `Proxy` that echoes back
 * whatever property name is read — component tests assert on structure and
 * copy, never on generated class names, and Bun cannot compile Sass anyway.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { transformSync } from "@babel/core"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import solidPreset from "babel-preset-solid"
import { plugin } from "bun"

// happy-dom's registrator overwrites every global it defines on its window —
// `fetch`, `Request`, `Response`, `Headers`, `ReadableStream`, `Blob`, and
// more — not just `document`. Fine in isolation, wrong here: `bin/test` runs
// the whole monorepo through one `bun test` invocation, one process, so a
// global left swapped by this preload leaks into every API/DB test file that
// runs afterward (it did, before this restore existed: `relay.test.ts`
// started reading response bodies through happy-dom's stream machinery
// instead of Bun's, silently returning wrong bytes rather than failing
// loudly). DOM globals are additive — nothing named `document` or `window`
// exists in Bun beforehand — so anything happy-dom overwrites that *already
// had a value* is restored verbatim; only genuinely new names are kept.
const preExisting = new Map(
  Object.getOwnPropertyNames(globalThis).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
)

if (!GlobalRegistrator.isRegistered) {
  await GlobalRegistrator.register()
  for (const [key, descriptor] of preExisting) {
    if (descriptor !== undefined) Object.defineProperty(globalThis, key, descriptor)
  }
  patchTemplateInnerHtmlForTableFragments()
}

/** See point 4 in the file-top comment. */
function patchTemplateInnerHtmlForTableFragments(): void {
  const templateProto = globalThis.HTMLTemplateElement.prototype

  let proto: object | null = templateProto
  let inherited: PropertyDescriptor | undefined
  while (proto !== null && inherited === undefined) {
    inherited = Object.getOwnPropertyDescriptor(proto, "innerHTML")
    proto = Object.getPrototypeOf(proto)
  }
  if (inherited?.get === undefined || inherited.set === undefined) {
    throw new Error("HTMLTemplateElement has no inherited innerHTML accessor to wrap")
  }
  const nativeGet = inherited.get
  const nativeSet = inherited.set

  // Tag → how to give it a real table ancestor, and where the parsed element
  // ends up once one exists.
  const TABLE_SCOPED_WRAP: Readonly<
    Record<string, { open: string; close: string; selector: string }>
  > = {
    th: { open: "<table><tbody><tr>", close: "</tr></tbody></table>", selector: "th" },
    td: { open: "<table><tbody><tr>", close: "</tr></tbody></table>", selector: "td" },
    tr: { open: "<table><tbody>", close: "</tbody></table>", selector: "tr" },
    tbody: { open: "<table>", close: "</table>", selector: "tbody" },
    thead: { open: "<table>", close: "</table>", selector: "thead" },
    tfoot: { open: "<table>", close: "</table>", selector: "tfoot" },
    caption: { open: "<table>", close: "</table>", selector: "caption" },
    colgroup: { open: "<table>", close: "</table>", selector: "colgroup" },
    col: { open: "<table><colgroup>", close: "</colgroup></table>", selector: "col" },
  }

  Object.defineProperty(templateProto, "innerHTML", {
    configurable: true,
    enumerable: inherited.enumerable,
    get(this: HTMLTemplateElement) {
      return nativeGet.call(this)
    },
    set(this: HTMLTemplateElement, html: string) {
      const tag = /^<\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.trim())?.[1]?.toLowerCase()
      const wrap = tag === undefined ? undefined : TABLE_SCOPED_WRAP[tag]
      if (wrap === undefined) {
        nativeSet.call(this, html)
        return
      }
      const table = this.ownerDocument.createElement("table")
      table.innerHTML = wrap.open + html + wrap.close
      const parsed = table.querySelector(wrap.selector)
      while (this.content.firstChild !== null) this.content.removeChild(this.content.firstChild)
      if (parsed !== null) this.content.appendChild(parsed)
    },
  })
}

const WEB_ROOT = join(import.meta.dir, "..", "..")

plugin({
  name: "solid-tsx-dom",
  setup(build) {
    // Substitutes the client build's source in place of the server build
    // that Bun's runtime resolver hands back for a bare `solid-js` /
    // `solid-js/web` import — see point 2 above.
    build.onLoad({ filter: /solid-js(\/web)?\/dist\/server\.js$/ }, (args) => ({
      contents: readFileSync(join(dirname(args.path), "dev.js"), "utf8"),
      loader: "js",
    }))

    build.onLoad({ filter: /\.tsx$/ }, (args) => {
      const source = readFileSync(args.path, "utf8")
      const result = transformSync(source, {
        filename: args.path,
        cwd: WEB_ROOT,
        presets: [
          [solidPreset, { generate: "dom", hydratable: false }],
          "@babel/preset-typescript",
        ],
        sourceMaps: false,
      })
      if (result?.code === null || result?.code === undefined) {
        throw new Error(`babel-preset-solid produced no output for ${args.path}`)
      }
      return { contents: result.code, loader: "js" }
    })

    build.onLoad({ filter: /\.module\.scss$/ }, () => ({
      contents: "export default new Proxy({}, { get: (_t, prop) => String(prop) })",
      loader: "js",
    }))
  },
})
