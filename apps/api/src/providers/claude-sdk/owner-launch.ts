import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk"
import { WORKSPACE_DIR } from "./config-dir"
import { ownerMonotonicMilliseconds } from "./owner-clock"
import { diagnoseOwnerLaunchFailure } from "./owner-helper"
import type { OwnerLaunch, OwnerLaunchConfig } from "./owner-launch-types"
import type { ReplicaGenerationHandle } from "./replica-lease"

export type { OwnerLaunch, OwnerLaunchConfig } from "./owner-launch-types"
/** One idle guardian per SDK query. No CLI child exists until activate(). */
export function createOwnerLaunch(
  config: OwnerLaunchConfig,
  accountId: string,
  metadata = false,
  generation?: ReplicaGenerationHandle,
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
  let renewalTimer: ReturnType<typeof setInterval> | undefined
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
    clearInterval(renewalTimer)
    rejectPrepared(new Error("credential owner cancelled"))
    rejectStarted(new Error("credential owner cancelled"))
    if (child) child.kill("SIGTERM")
    else {
      rejectReady(new Error("credential owner cancelled"))
      resolveExit()
    }
  }
  const authority = () => {
    assertGeneration()
    if (!generation) return []
    const sampled = ownerMonotonicMilliseconds()
    const remaining = Math.floor(generation.remainingMs())
    if (remaining <= 0) throw new Error("credential owner lease expired")
    // Absolute kernel deadlines cannot gain authority while queued or paused.
    const deadline = sampled + BigInt(remaining)
    return [generation.owner, String(generation.generation), String(deadline)]
  }
  const assertGeneration = () => {
    try {
      generation?.assert()
    } catch (error) {
      cancel()
      throw error
    }
  }
  generation?.signal.addEventListener("abort", cancel, { once: true })
  void exited
    .finally(() => {
      clearInterval(renewalTimer)
      generation?.signal.removeEventListener("abort", cancel)
    })
    .catch(() => {})
  return {
    ready,
    exited,
    started,
    cancel,
    prepare() {
      assertGeneration()
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
      assertGeneration()
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
      assertGeneration()
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
      if (metadata || generation) start.write("S")
      else start.end("S")
    },
    spawn(input) {
      const fence = authority()
      const directory = join(config.root, accountId)
      const workspace = join(config.root, WORKSPACE_DIR)
      // Inference subprocesses run in the shared neutral workspace (`options.ts`, #296); login and
      // metadata holders run in the Account's own directory. Either router-managed directory is
      // admissible; the credential authority is the env — `CLAUDE_CONFIG_DIR` must be this
      // Account's directory, which the helper re-verifies from its own anchored root fd.
      if (
        (input.cwd !== directory && input.cwd !== workspace) ||
        input.env.CLAUDE_CONFIG_DIR !== directory
      )
        throw new Error("credential directory authority mismatch")
      if (cancelled) throw new Error("credential owner cancelled")
      if (child) throw new Error("credential owner launch scope was reused")
      // The guardian hands this cwd to the CLI (config-owner.c no longer chdirs), and node refuses
      // to spawn into a missing directory — an idempotent self-heal for a volume provisioned
      // before the workspace existed. Provisioning creates it anchored; a file or symlink in its
      // place fails the spawn loudly instead of running somewhere unexamined.
      if (input.cwd === workspace) mkdirSync(workspace, { recursive: true, mode: 0o700 })
      const guardian = spawn(
        config.helperPath,
        [
          generation ? (metadata ? "hold-fenced" : "run-fenced") : metadata ? "hold" : "run",
          config.root,
          accountId,
          randomUUID(),
          String(config.maximumOwners),
          String(config.termGraceMs),
          String(config.pollMs),
          String(config.maximumChildren),
          String(config.admissionTimeoutMs),
          ...fence,
          input.command,
          ...input.args,
        ],
        { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] },
      )
      if (guardian.pid === undefined) {
        // No process came to exist. The runtime still emits `error` on a later tick — with no
        // listener that is an uncaught exception, which shuts the whole router down (#447) — and
        // the protocol pipes below are null. Nothing was spawned, so nothing owns the directory:
        // the exit is certain (`cancel` settles it) and the failure is this Account's alone.
        guardian.once("error", () => {})
        cancel()
        throw diagnoseOwnerLaunchFailure(config.helperPath, input.cwd)
      }
      child = guardian
      const admissionTimer = setTimeout(() => {
        rejectReady(new Error("credential owner readiness timed out"))
        cancel()
      }, config.admissionTimeoutMs)
      const status = guardian.stdio[3] as Readable
      start = guardian.stdio[4] as Writable
      if (generation) {
        let sentDeadline = BigInt(fence[2] ?? "0")
        renewalTimer = setInterval(() => {
          try {
            const [owner, token, deadline] = authority()
            const next = BigInt(deadline ?? "0")
            if (isReady && !quiescent && next > sentDeadline) {
              sentDeadline = next
              start?.write(`U ${owner} ${token} ${deadline}\n`)
            }
          } catch {
            cancel()
          }
        }, config.pollMs)
      }
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
