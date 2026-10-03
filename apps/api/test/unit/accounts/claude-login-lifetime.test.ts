import { expect, test } from "bun:test"
import { createClaudeLoginLifetime } from "../../../src/services/accounts/connect/claude-lifetime"

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test("stop includes an owner handle first revealed after the admitted starting flight ends", async () => {
  const url = deferred(),
    exit = deferred()
  const lifetime = createClaudeLoginLifetime(100, () => {})
  const begin = lifetime.run("account", async () => {
    await url.promise
    lifetime.observe("account", {
      authorizeUrl: "https://fixture.invalid",
      state: "state",
      submit: async () => {},
      exited: exit.promise,
      cancel: () => {},
      cancelAsync: () => exit.promise,
    })
  })
  let stopped = false
  const stop = lifetime.stop().then(() => {
    stopped = true
  })
  url.release()
  await begin
  await new Promise((resolve) => setTimeout(resolve, 1))
  expect(stopped).toBe(false)
  exit.release()
  await stop
  expect(stopped).toBe(true)
})

test("unknown guardian exit is reported while its persistent marker remains cleanup authority", async () => {
  const exit = deferred()
  const reports: number[] = []
  const lifetime = createClaudeLoginLifetime(100, (owners) => reports.push(owners))
  lifetime.observe("account", {
    authorizeUrl: "https://fixture.invalid",
    state: "state",
    submit: async () => {},
    exited: exit.promise.then(() => {
      throw new Error("guardian lost")
    }),
    cancel: () => {},
    cancelAsync: () => exit.promise,
  })
  exit.release()
  await new Promise((resolve) => setTimeout(resolve, 1))
  await lifetime.stop()
  expect(reports).toEqual([1])
})
