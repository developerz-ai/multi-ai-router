import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseEnv } from "../../src/config/env"

/**
 * The image and the test suite have to be running the same bun, and a rebuild of an old tag has to
 * produce the old image. Neither is true by default.
 *
 * `oven/bun:1` floats an entire major: the pipeline tests on the bun in `ci.yml`'s `BUN_VERSION` and
 * the image ships whatever `:1` resolved to on build day — 1.9.x against code nobody ran on 1.9.x,
 * with the workflow comment still claiming the two "never diverge". And a version tag is mutable, so
 * even `:1.3.0` can be re-pushed under an old release: rebuilding `v1.0.0` a year from now would
 * produce a different image from the one that shipped. A tag plus an index digest fixes both.
 *
 * The file read is the assertion, not a shortcut around one — the artifacts under test *are* the
 * checked-in `Dockerfile` and workflow, and there is nothing to inject in their place. Nothing here
 * touches a network: a digest cannot be resolved offline, so what is provable statically is that the
 * pins exist, agree with each other, and agree with the runtime CI tested. That the digest names the
 * bun the tag claims is proved at build time instead, by the `bun --version` check each stage runs
 * and this test requires to be present.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

const DOCKERFILE = readFileSync(`${ROOT}Dockerfile`, "utf8")
const CI_WORKFLOW = readFileSync(`${ROOT}.github/workflows/ci.yml`, "utf8")
const COMPOSE = readFileSync(`${ROOT}docker-compose.yml`, "utf8")
const MANIFEST: { engines?: { bun?: string } } = JSON.parse(
  readFileSync(`${ROOT}package.json`, "utf8"),
)

/** `FROM oven/bun:<version>[-variant]@sha256:<64 hex> AS <stage>` — every part required. */
const BASE_IMAGE =
  /^FROM\s+oven\/bun:(?<version>[^\s@-]+)(?<variant>-[^\s@]+)?@sha256:(?<digest>[0-9a-f]{64})\s+AS\s+(?<stage>\w+)\s*$/gm

interface Base {
  readonly version: string
  readonly variant: string
  readonly digest: string
  readonly stage: string
}

function bases(): readonly Base[] {
  return [...DOCKERFILE.matchAll(BASE_IMAGE)].map((match) => {
    const { version, variant, digest, stage } = match.groups ?? {}
    // The regex cannot match without them; narrowing without `!`, which Biome refuses.
    if (!version || !digest || !stage) throw new Error(`unparsable FROM: ${match[0]}`)
    return { version, variant: variant ?? "", digest, stage }
  })
}

/** Every `FROM` in the file, pinned or not — so an unpinned one is a missing pin, not a miss. */
function fromLines(): readonly string[] {
  return DOCKERFILE.split("\n").filter((line) => /^FROM\s/.test(line))
}

describe("the container base image", () => {
  test("pins an exact bun version and a digest on every stage", () => {
    const pinned = bases()

    // Both stages: the builder compiles the bundle, the runtime executes it. A floating runtime is
    // the worse of the two, but a builder that bundles on an untested bun ships the result.
    expect(pinned.map((base) => base.stage)).toEqual(["builder", "runtime"])
    expect(fromLines()).toHaveLength(pinned.length)

    for (const base of pinned) {
      expect(base.version).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  test("runs the runtime CI tested on, named in one place", () => {
    // `ci.yml` pins the bun that `bun install`, `bun test` and `bun run build` all use. The image
    // executing a different one means the suite proved nothing about what ships.
    const ci = CI_WORKFLOW.match(/^\s*BUN_VERSION:\s*"(?<version>[^"]+)"/m)?.groups?.version
    expect(ci).toMatch(/^\d+\.\d+\.\d+$/)

    for (const base of bases()) {
      expect(base.version).toBe(ci as string)
    }
  })

  test("uses the same version for the builder and the runtime, in two variants", () => {
    const [builder, runtime] = bases()

    expect(builder?.variant).toBe("")
    expect(runtime?.variant).toBe("-slim")
    expect(runtime?.version).toBe(builder?.version as string)
    // Different images, so necessarily different digests — one copied onto both lines would pin
    // the runtime to the toolchain-carrying base, silently tripling the shipped image.
    expect(runtime?.digest).not.toBe(builder?.digest as string)
  })

  test("satisfies the bun floor the workspace declares", () => {
    const range = MANIFEST.engines?.bun
    // Asserted rather than pattern-matched loosely: a range shape this test cannot read would
    // otherwise stop checking anything and still pass.
    expect(range).toMatch(/^>=\d+\.\d+\.\d+$/)
    const floor = (range as string).slice(2).split(".").map(Number)

    for (const base of bases()) {
      const pin = base.version.split(".").map(Number)
      expect(
        pin.map((part, index) => part - (floor[index] ?? 0)).find((delta) => delta !== 0) ?? 0,
      ).toBeGreaterThanOrEqual(0)
    }
  })

  test("proves at build time that each digest names the version its tag claims", () => {
    // The digest is what resolves; the tag beside it is decorative. Copying a mismatched pair is
    // invisible in a diff and unprovable offline, so each stage re-asks the base what it is.
    const asserts = [...DOCKERFILE.matchAll(/\[\s*"\$\(bun --version\)"\s*=\s*"([^"]+)"\s*\]/g)]

    expect(asserts).toHaveLength(bases().length)
    for (const [index, base] of bases().entries()) {
      expect(asserts[index]?.[1]).toBe(base.version)
    }
  })
})

describe("the node_modules prune", () => {
  test("fails the build when its size heuristic stops matching", () => {
    // `find … -size +100M -delete` succeeds when it matches nothing. The day the SDK's platform
    // binary drops under the threshold, ~500 MB of duplicate `claude` copies quietly return and
    // every layer downstream still builds green. Nothing else weighs the image, so the delete has
    // to assert its own match.
    const prune = DOCKERFILE.match(
      /^RUN[^\n]*(?:\\\n[^\n]*)*claude -size \+100M[^\n]*(?:\\\n[^\n]*)*/m,
    )
    expect(prune).not.toBeNull()

    const step = prune?.[0] ?? ""
    expect(step).toContain("-print -delete")
    // A count, compared. Not a bare delete whose zero-match case is a success.
    expect(step).toMatch(/\[\s*"\$pruned"\s*-gt\s*0\s*\]/)
    expect(step).toContain("exit 1")
  })
})

describe("the container init", () => {
  /** `ENTRYPOINT ["…"]` — exec form only; the shell form would swallow the signal outright. */
  function entrypoint(): readonly string[] {
    const line = DOCKERFILE.match(/^ENTRYPOINT (?<argv>\[.*\])\s*$/m)?.groups?.argv
    expect(line).toBeDefined()
    const argv: unknown = JSON.parse(line as string)
    expect(Array.isArray(argv)).toBe(true)
    return argv as readonly string[]
  }

  test("runs the router under an init, because bun is not one", () => {
    // Every Claude subscription request spawns a `claude` subprocess, and whatever *it* spawns is
    // re-parented to PID 1 when it outlives its parent. A PID 1 that never calls `wait()` collects
    // one zombie per orphan, forever, on the longest-running process in the deployment. Nothing in
    // the router's own code can fix that: reaping belongs to PID 1.
    const argv = entrypoint()

    expect(argv[0]).toBe("/usr/bin/tini")
    // Subreaper, so the reaping survives something putting a second init above this one —
    // `docker run --init`, compose's `init: true`. tini silently stops reaping otherwise.
    expect(argv).toContain("-s")
    // And it still starts the same process it always did, after the argument separator.
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["bun", "run", "dist/api/index.js"])
  })

  test("stages that init as a static binary and proves it runs at build time", () => {
    // Static: a dynamically linked copy would repeat the libc trap the `claude` COPY documents,
    // and fail as a bare "no such file or directory" on a file that is plainly there.
    expect(DOCKERFILE).toMatch(/^COPY --from=builder \/usr\/bin\/tini-static \/usr\/bin\/tini$/m)
    expect(DOCKERFILE).toMatch(/^RUN tini --version$/m)
  })
})

describe("the shutdown grace", () => {
  test("compose allows more time than the router's drain takes", () => {
    // The router stops accepting, waits up to SHUTDOWN_DRAIN_MS for in-flight responses, and only
    // then flushes its usage rows, quota readings and account statuses. A stop grace shorter than
    // that wait is a SIGKILL landing mid-drain: streams truncated *and* the bookkeeping lost.
    // Docker's default is 10s, which is under the drain's default — hence the explicit setting.
    const grace = COMPOSE.match(/^\s*stop_grace_period:\s*(?<seconds>\d+)s\s*$/m)?.groups?.seconds
    expect(grace).toMatch(/^\d+$/)

    const env = parseEnv({
      DATABASE_URL: "postgres://router:router@postgres:5432/router",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "hunter2",
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    })
    // The whole budget, not just the drain: the readiness window runs first and the pool close runs
    // last, so a grace that only covers the middle step still kills mid-shutdown.
    const budgetMs =
      env.shutdownReadyGraceMs + env.shutdownDrainMs + env.databasePool.closeTimeoutSeconds * 1_000

    expect(Number(grace) * 1_000).toBeGreaterThan(budgetMs)
  })
})

describe("the image labels", () => {
  // Read from the outside — `docker inspect`, `docker buildx imagetools inspect` — with no shell in
  // the container. release.yml layers docker/metadata-action's richer set on top, so these are the
  // floor: they are what a local `docker build` carries, which is the build least able to explain
  // itself later.
  const label = (name: string): string | undefined =>
    DOCKERFILE.match(new RegExp(`org\\.opencontainers\\.image\\.${name}="([^"]*)"`))?.[1]

  test("names where the image came from, what it is, and under which licence", () => {
    expect(label("source")).toBe("https://github.com/developerz-ai/multi-ai-router")
    expect(label("url")).toBe("https://github.com/developerz-ai/multi-ai-router")
    expect(label("licenses")).toBe("MIT")
    expect(label("title")).toBe("multi-ai-router")
    expect(label("description")).toBeTruthy()
    expect(label("documentation")).toContain("README.md")
  })

  test("carries the build's revision, defaulting to the honest unknown", () => {
    // Same ARG the running process reports as `router_build_info{revision}`, so the label an
    // operator reads from outside and the metric they read from inside cannot disagree.
    expect(label("revision")).toBe("${ROUTER_REVISION}")
    expect(DOCKERFILE).toMatch(/^ARG ROUTER_REVISION=unknown$/m)
  })

  test("declares a version, which bin/verify-version holds to the constant", () => {
    expect(label("version")).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  })
})
