import { dlopen, FFIType, ptr } from "bun:ffi"

let clock: ReturnType<typeof openClock> | undefined
function openClock() {
  return dlopen("libc.so.6", {
    clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  })
}

/** Bun hrtime can use a process-relative origin, unlike the guardian's kernel clock. */
export function ownerMonotonicMilliseconds(): bigint {
  if (process.platform !== "linux") throw new Error("credential ownership requires Linux")
  clock ??= openClock()
  const timespec = new BigInt64Array(2)
  if (clock.symbols.clock_gettime(1, ptr(timespec)) !== 0)
    throw new Error("credential owner monotonic clock unavailable")
  const seconds = timespec[0]
  const nanos = timespec[1]
  if (seconds === undefined || nanos === undefined || seconds < 0n || nanos < 0n)
    throw new Error("credential owner monotonic clock invalid")
  return seconds * 1000n + nanos / 1_000_000n
}
