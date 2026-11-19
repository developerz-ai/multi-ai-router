import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const marker = "SYNTHETIC_CREDENTIAL_DO_NOT_PRINT"
const pool = { name: "demo", members: ["primary", "overflow"], overflow: "overflow" }
const bootUrl = new URL("../../src/boot.ts", import.meta.url).href

async function boot(path?: string, forbidRead = false) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `import { readEnv } from ${JSON.stringify(bootUrl)};
     ${
       forbidRead
         ? 'const fs = await import("node:fs"); fs.default.readFileSync = () => { throw new Error("unexpected filesystem read") };'
         : ""
     }
     process.stdout.write(JSON.stringify(readEnv().poolRoster));`,
    ],
    {
      env: {
        DATABASE_URL: "postgres://router:router@localhost/router",
        ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        ...(path === undefined ? {} : { POOL_ROSTER_PATH: path }),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exit, stdout, stderr }
}

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pool-roster-"))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function refused(result: Awaited<ReturnType<typeof boot>>, path: string, issue: string) {
  expect(result.exit).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toBe(
    `Invalid environment configuration:\n  POOL_ROSTER_PATH (${path}): ${issue}\n`,
  )
  expect(result.stderr).not.toContain(marker)
}

test("actual readEnv skips filesystem reads when unset or blank", async () => {
  for (const path of [undefined, " \t"]) {
    expect(await boot(path, true)).toEqual({ exit: 0, stdout: "null", stderr: "" })
  }
})

test("actual readEnv loads valid mounted snapshot", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "roster.json")
    const roster = { version: 1, pools: [pool] }
    await writeFile(path, JSON.stringify(roster))
    const result = await boot(path)
    expect(result.exit).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toEqual(roster)
  })
})

test("missing file and directory refuse boot without relying on permission bits", async () => {
  await fixture(async (directory) => {
    for (const path of [join(directory, "missing.json"), directory]) {
      refused(await boot(path), path, "cannot read roster file")
    }
  })
})

const refusals: Array<[string, string, string]> = [
  ["malformed", `{${marker}`, "invalid JSON"],
  ["version", JSON.stringify({ version: marker, pools: [] }), "version: version must be 1"],
  ["null", "null", "roster: invalid type or missing field"],
  ["missing", "{}", "version: version must be 1"],
  ["pools", JSON.stringify({ version: 1, pools: marker }), "pools: invalid type or missing field"],
  [
    "unknown-root",
    JSON.stringify({ version: 1, pools: [], [marker]: marker }),
    "roster: unknown fields are not allowed",
  ],
  ...(
    [
      ["unknown-pool", { ...pool, [marker]: marker }, "pools.0: unknown fields are not allowed"],
      ["blank-name", { ...pool, name: " " }, "pools.0.name: must be nonblank"],
      [
        "blank-member",
        { ...pool, members: [" ", "overflow"] },
        "pools.0.members.0: must be nonblank",
      ],
      ["blank-overflow", { ...pool, overflow: " " }, "pools.0.overflow: must be nonblank"],
      [
        "member-type",
        { ...pool, members: [false, "overflow"] },
        "pools.0.members.0: invalid type or missing field",
      ],
      ["empty", { ...pool, members: [] }, "pools.0.members: members must not be empty"],
      [
        "duplicates",
        { ...pool, members: ["overflow", "overflow"] },
        "pools.0.members: duplicate members",
      ],
      ["outsider", { ...pool, overflow: marker }, "pools.0.overflow: overflow must be a member"],
      [
        "sole",
        { ...pool, members: ["overflow"] },
        "pools.0.overflow: overflow must not be sole member",
      ],
    ] satisfies Array<[string, unknown, string]>
  ).map(([name, value, issue]): [string, string, string] => [
    name,
    JSON.stringify({ version: 1, pools: [value] }),
    issue,
  ]),
  [
    "duplicate-pools",
    JSON.stringify({ version: 1, pools: [pool, pool] }),
    "pools.1.name: duplicate pool name",
  ],
]

for (const [name, contents, issue] of refusals) {
  test(`actual readEnv refuses ${name} with only a sanitized first issue`, async () => {
    await fixture(async (directory) => {
      const path = join(directory, "roster.json")
      await writeFile(path, contents)
      refused(await boot(path), path, issue)
    })
  })
}
