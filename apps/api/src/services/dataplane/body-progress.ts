import { type BodyReadOptions, readRequestBody } from "./body/read"
import type { RequestProgress } from "./observe"
import type { DataPlaneClock } from "./types"

/** Keep the outstanding upload wait visible to shutdown before read-finally callbacks run. */
export function readTrackedRequestBody(
  request: Request,
  options: BodyReadOptions | undefined,
  progress: RequestProgress,
  clock: DataPlaneClock,
) {
  return readRequestBody(request, {
    ...options,
    signal: request.signal,
    elapsed: () => clock.elapsed(),
    onReadWaitStart: (started) => {
      progress.bodyReadWaitingSince = started
    },
    onReadWait: (milliseconds) => {
      progress.bodyReadMs += milliseconds
      progress.bodyReadWaitingSince = undefined
    },
  })
}
