import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { AsyncBackgroundStartGuard, UpstreamStartGuard } from "../upstream-admission"
import type { OwnerLaunch } from "./owner-launch"

export type OwnerLaunchFactory = (accountId: string) => OwnerLaunch
/** SDK construction only starts an idle guardian; readiness precedes both final guards. */
export async function ownedQuery<T>(input: {
  readonly accountId: string
  readonly options: Options
  readonly signal: AbortSignal
  readonly ownerLaunch?: OwnerLaunchFactory
  readonly beforeBackgroundUpstreamStart?: AsyncBackgroundStartGuard
  readonly beforeUpstreamStart?: UpstreamStartGuard
  readonly onUpstreamStarted?: () => void
  readonly run: (options: Options) => T
}): Promise<T> {
  const owner = input.ownerLaunch?.(input.accountId)
  try {
    if (!owner) {
      await input.beforeBackgroundUpstreamStart?.()
      input.signal.throwIfAborted()
      input.beforeUpstreamStart?.()
      const messages = input.run(input.options)
      input.onUpstreamStarted?.()
      return messages
    }
    const messages = input.run({ ...input.options, spawnClaudeCodeProcess: owner.spawn })
    await owner.ready
    await owner.prepare()
    await input.beforeBackgroundUpstreamStart?.()
    input.signal.throwIfAborted()
    owner.assertReady()
    input.beforeUpstreamStart?.()
    owner.activate()
    await owner.started
    input.onUpstreamStarted?.()
    return messages
  } catch (error) {
    owner?.cancel()
    throw error
  }
}
