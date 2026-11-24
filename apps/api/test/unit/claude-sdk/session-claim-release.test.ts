import { expect, test } from "bun:test"
import { createSessionClaims } from "../../../src/providers/claude-sdk/session/inflight"
import { claimSessionTurnDurable } from "../../../src/providers/claude-sdk/session/inflight-durable"

/** A lease won after its turn was released used to be held by nobody and returned by nobody. */
test("a durable lease won after the turn let go is handed back", async () => {
  for (const sdkSessionId of [null, "sdk-session"]) {
    let outstanding = 0
    let grant = (): void => {}
    const gate = new Promise<void>((resolve) => {
      grant = resolve
    })
    const claim = claimSessionTurnDurable(createSessionClaims(), "key", "account", sdkSessionId, {
      tryAcquire: async () => {
        await gate
        outstanding += 1
        let held = true
        const release = async (): Promise<void> => {
          if (held) outstanding -= 1
          held = false
        }
        return { acquired: true, value: { release } }
      },
    })
    const preparing = claim.prepare()
    claim.release()
    grant()
    expect(await preparing).toBe(false)
    await Bun.sleep(0)
    expect(outstanding).toBe(0)
    expect(await claim.prepare()).toBe(false)
  }
})

test("a lease release that rejects while preparing is a refusal, never a throw", async () => {
  let calls = 0
  const claim = claimSessionTurnDurable(createSessionClaims(), "key", "account", "sdk", {
    tryAcquire: async () => {
      calls += 1
      if (calls === 2) throw new Error("pool gone")
      return {
        acquired: true,
        value: {
          release: async () => {
            throw new Error("connection lost")
          },
        },
      }
    },
  })
  expect(await claim.prepare()).toBe(false)
  expect(claim.refused).toBe("unavailable")
  claim.release()
})

test("a turn released before its conversation lock is granted never waits on the SDK lock", async () => {
  const conversation = Promise.withResolvers<void>()
  const asked: number[] = []
  let returned = false
  const claim = claimSessionTurnDurable(createSessionClaims(), "key", "account", "sdk", {
    tryAcquire: async (id) => {
      asked.push(id)
      // The second lock is held by a turn that does not end: waiting on it held the first.
      if (asked.length === 2) return new Promise(() => {})
      await conversation.promise
      return {
        acquired: true,
        value: {
          release: async () => {
            returned = true
          },
        },
      }
    },
  })
  const preparing = claim.prepare()
  claim.release()
  conversation.resolve()
  expect(await Promise.race([preparing, Bun.sleep(100).then(() => "waiting")])).toBe(false)
  expect(asked).toHaveLength(1)
  expect(returned).toBe(true)
})
