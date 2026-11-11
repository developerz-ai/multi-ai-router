// Ambient types for the `bun test` harness only (tsconfig.tests.json). The SPA
// build never sees these: they describe what solid-plugin.ts installs.

// babel-preset-solid ships no declarations; solid-plugin.ts passes it to
// @babel/core as an opaque preset.
declare module "babel-preset-solid" {
  const preset: object
  export default preset
}

// @happy-dom/global-registrator puts happy-dom's window API on `window`; the
// tests use it only to move the location.
interface Window {
  readonly happyDOM: { setURL(url: string): void }
}
