import type { DispatcherDeps, DispatchOptions } from "./dispatcher-config"
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "./dispatcher-config"
import type { RuntimeInput } from "./runtime"
import type { DataPlaneClock, FetchLike } from "./types"

/** The runtime fields that come from the dispatcher's own deps and options, not the request. */
export function sharedRuntimeInput(
  deps: DispatcherDeps,
  options: DispatchOptions,
  clock: DataPlaneClock,
  call: FetchLike,
) {
  return {
    health: deps.health,
    ...(options.selection?.unknownResetRetryAfterSeconds === undefined
      ? {}
      : { unknownResetRetryAfterSeconds: options.selection.unknownResetRetryAfterSeconds }),
    ...(options.selection?.quotaSpentThreshold === undefined
      ? {}
      : { quotaSpentThreshold: options.selection.quotaSpentThreshold }),
    ...(deps.recovery === undefined ? {} : { recovery: deps.recovery }),
    cipher: deps.cipher,
    call,
    ...(deps.invokeSdk === undefined ? {} : { invokeSdk: deps.invokeSdk }),
    ...(deps.quota === undefined ? {} : { quota: deps.quota }),
    ...(deps.prices === undefined ? {} : { prices: deps.prices }),
    clock,
    timeoutMs: options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    ...(options.upstreamStream === undefined ? {} : { streamDeadlines: options.upstreamStream }),
    ...(deps.reasoningSealer === undefined ? {} : { reasoningSealer: deps.reasoningSealer }),
    ...(options.upstreamErrorMaxBytes === undefined
      ? {}
      : { errorMaxBytes: options.upstreamErrorMaxBytes }),
    responseObservationMaxBytes: options.responseObservationMaxBytes ?? 65_536,
    ...(options.upstreamStreamCapMinMs === undefined
      ? {}
      : { streamCapMinMs: options.upstreamStreamCapMinMs }),
    ...(options.bufferedBodyMaxBytes === undefined
      ? {}
      : { bufferedBodyMaxBytes: options.bufferedBodyMaxBytes }),
    ...(options.maxTranslationSseFrameBytes === undefined
      ? {}
      : { translationFrameMaxBytes: options.maxTranslationSseFrameBytes }),
  } satisfies Partial<RuntimeInput>
}
