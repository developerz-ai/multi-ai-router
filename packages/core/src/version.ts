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
export const VERSION = "2.0.1"

/**
 * What `router_build_info{revision}` and the boot log report when nothing told the build which
 * commit it is — a local `docker build`, a `bun run dev`, a test.
 *
 * The revision is deploy metadata, not a constant: it arrives as `ROUTER_REVISION` (baked into the
 * released image from the tagged commit's sha). A version alone cannot separate two builds that
 * call themselves the same thing — a rebuilt `:latest`, an rc cut twice, an image built from a
 * dirty tree — so the sha is what an operator joins on when the version is not enough. `unknown`
 * is the honest answer for a build nobody stamped; never a fake sha, never an empty label.
 */
export const UNKNOWN_REVISION = "unknown"
