/** Deadlines also apply to injected transports and stalled response bodies. */
export async function awaitOAuthResponse(
  fetch: (request: Request) => Promise<Response>,
  request: Request,
): Promise<Response> {
  const pending = fetch(request)
  void pending.then(
    (late) => {
      if (request.signal.aborted) void late.body?.cancel().catch(() => {})
    },
    () => {},
  )
  return abortable(pending, request.signal)
}

/** Also bounds injected transports that do not themselves observe Request.signal. */
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  let abort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
  })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

export async function readOAuthResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) return JSON.parse("")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ""
  let complete = false
  try {
    while (true) {
      const next = await abortable(reader.read(), signal)
      if (next.done) {
        complete = true
        break
      }
      body += decoder.decode(next.value, { stream: true })
    }
    return JSON.parse(body + decoder.decode())
  } finally {
    if (!complete) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
