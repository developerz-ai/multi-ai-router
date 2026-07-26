/**
 * The version this build calls itself.
 *
 * **This constant is the source; every workspace `package.json` restates it.** Reading the manifest
 * back instead would pull a file outside `rootDir` into a `composite` build and inline the whole
 * thing — scripts, dependency tree and all — into the browser bundle, to recover one field. So the
 * string is written once here, and `test/unit/version.test.ts` fails the gate the moment a manifest
 * drifts from it.
 *
 * It reaches an operator through `GET /healthz`, `router_build_info{version}`, the boot log, the
 * settings endpoint and the console footer. Five surfaces, one string: a bug report that quotes a
 * version quotes the same build every time.
 */
export const VERSION = "1.0.0"
