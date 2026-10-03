import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"

export interface OwnerLaunchConfig {
  readonly helperPath: string
  readonly root: string
  readonly maximumOwners: number
  readonly termGraceMs: number
  readonly pollMs: number
  readonly maximumChildren: number
  readonly admissionTimeoutMs: number
}
export interface OwnerLaunch {
  readonly spawn: (input: SpawnOptions) => SpawnedProcess
  readonly ready: Promise<void>
  readonly exited: Promise<void>
  readonly started: Promise<void>
  prepare(): Promise<void>
  release(): void
  assertReady(): void
  activate(): void
  cancel(): void
}
/** One idle guardian per SDK query. No CLI child exists until activate(). */
export function createOwnerLaunch(
  config: OwnerLaunchConfig,
  accountId: string,
  metadata = false,
): OwnerLaunch {
  let child: ChildProcess | undefined
  let start: Writable | undefined
  let activated = false
  let isReady = false
  let quiescent = false
  let isPrepared = false
  let hasStarted = false
  let prepareSent = false
  let resolvePrepared: () => void = () => {}
  let rejectPrepared: (error: Error) => void = () => {}
  let resolveStarted: () => void = () => {}
  let rejectStarted: (error: Error) => void = () => {}
  const prepared = new Promise<void>((resolve, reject) => {
    resolvePrepared = resolve
    rejectPrepared = reject
  })
  const started = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve
    rejectStarted = reject
  })
  void prepared.catch(() => {})
  void started.catch(() => {})
  let prepareTimer: ReturnType<typeof setTimeout> | undefined
  let startTimer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  let resolveExit: () => void = () => {}
  let rejectExit: (error: Error) => void = () => {}
  const exited = new Promise<void>((resolve, reject) => {
    resolveExit = resolve
    rejectExit = reject
  })
  void exited.catch(() => {})
  let resolveReady: () => void = () => {}
  let rejectReady: (error: Error) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // A synchronous SDK construction failure can leave readiness unawaited.
  void ready.catch(() => {})
  const cancel = () => {
    cancelled = true
    rejectPrepared(new Error("credential owner cancelled"))
    rejectStarted(new Error("credential owner cancelled"))
    if (child) child.kill("SIGTERM")
    else {
      rejectReady(new Error("credential owner cancelled"))
      resolveExit()
    }
  }
  return {
    ready,
    exited,
    started,
    cancel,
    prepare() {
      if (!isReady || cancelled || quiescent || !start || child?.exitCode !== null)
        return Promise.reject(new Error("credential owner preparation refused"))
      if (!prepareSent) {
        prepareSent = true
        prepareTimer = setTimeout(() => {
          rejectPrepared(new Error("credential owner preparation timed out"))
          cancel()
        }, config.admissionTimeoutMs)
        start.write("P")
      }
      return prepared
    },
    release() {
      if (metadata && activated) start?.end("D")
    },
    assertReady() {
      if (
        !isReady ||
        !isPrepared ||
        quiescent ||
        cancelled ||
        !child ||
        !start ||
        activated ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        throw new Error("credential owner was not ready for activation")
    },
    activate() {
      if (
        !isReady ||
        !isPrepared ||
        quiescent ||
        cancelled ||
        !child ||
        !start ||
        activated ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        throw new Error("credential owner was not ready for activation")
      activated = true
      startTimer = setTimeout(() => {
        rejectStarted(new Error("credential owner activation timed out"))
        cancel()
      }, config.admissionTimeoutMs)
      if (metadata) start.write("S")
      else start.end("S")
    },
    spawn(input) {
      const directory = join(config.root, accountId)
      if (input.cwd !== directory || input.env.CLAUDE_CONFIG_DIR !== directory)
        throw new Error("credential directory authority mismatch")
      if (cancelled) throw new Error("credential owner cancelled")
      if (child) throw new Error("credential owner launch scope was reused")
      child = spawn(
        config.helperPath,
        [
          metadata ? "hold" : "run",
          config.root,
          accountId,
          randomUUID(),
          String(config.maximumOwners),
          String(config.termGraceMs),
          String(config.pollMs),
          String(config.maximumChildren),
          String(config.admissionTimeoutMs),
          input.command,
          ...input.args,
        ],
        { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] },
      )
      const guardian = child
      const admissionTimer = setTimeout(() => {
        rejectReady(new Error("credential owner readiness timed out"))
        cancel()
      }, config.admissionTimeoutMs)
      const status = guardian.stdio[3] as Readable
      start = guardian.stdio[4] as Writable
      start.on("error", cancel)
      status.on("error", () => {
        rejectReady(new Error("credential owner protocol unavailable"))
        cancel()
      })
      status.on("data", (data: Buffer) => {
        for (const byte of data) {
          if (byte === 82 && !isReady) {
            isReady = true
            clearTimeout(admissionTimer)
            resolveReady()
          } else if (byte === 65 && prepareSent && !isPrepared) {
            isPrepared = true
            clearTimeout(prepareTimer)
            resolvePrepared()
          } else if (byte === 66 && isPrepared && activated && !hasStarted) {
            hasStarted = true
            clearTimeout(startTimer)
            resolveStarted()
          } else if (byte === 81 && isReady && !quiescent) {
            quiescent = true
            if (!isPrepared) rejectPrepared(new Error("credential owner preparation refused"))
            if (!hasStarted) rejectStarted(new Error("credential owner activation refused"))
          } else {
            rejectReady(new Error("credential owner readiness was invalid"))
            cancel()
          }
        }
      })
      guardian.once("error", () => {
        rejectReady(new Error("credential owner launch unavailable"))
        rejectExit(new Error("credential owner exit is uncertain"))
        rejectPrepared(new Error("credential owner preparation unavailable"))
        rejectStarted(new Error("credential owner activation unavailable"))
      })
      guardian.once("close", () => {
        clearTimeout(admissionTimer)
        clearTimeout(prepareTimer)
        clearTimeout(startTimer)
        if (!isPrepared) rejectPrepared(new Error("credential owner preparation unavailable"))
        if (!hasStarted) rejectStarted(new Error("credential owner activation unavailable"))
        if (quiescent) resolveExit()
        else rejectExit(new Error("credential owner exit is uncertain"))
        if (!isReady) rejectReady(new Error("credential owner admission refused"))
        input.signal?.removeEventListener("abort", cancel)
      })
      status.once("end", () => {
        if (!isReady) rejectReady(new Error("credential owner readiness was unavailable"))
      })
      input.signal?.addEventListener("abort", cancel, { once: true })
      if (input.signal?.aborted) cancel()
      // SDK forced cancellation requests child-tree KILL/reaping, never guardian SIGKILL.
      const originalKill = guardian.kill.bind(guardian)
      guardian.kill = (signal) =>
        originalKill(signal === "SIGKILL" || signal === 9 ? "SIGUSR2" : signal)
      return guardian as SpawnedProcess
    },
  }
}
