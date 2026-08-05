import { lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test as bunTest, type TestOptions } from "bun:test"

type TrackedProcess = {
  name: string
  pid: number
  state: () => {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    killed: boolean
  }
}

type TrackedPath = {
  name: string
  path: string
}

export type DiagnosticTestContext = {
  /** 注册超时时需要检查的子进程，并返回取消注册函数。 */
  trackProcess(name: string, process: Pick<Bun.Subprocess, "pid" | "exitCode" | "signalCode" | "killed">): () => void
  /** 注册超时时需要检查的文件系统路径，并返回取消注册函数。 */
  trackPath(name: string, path: string): () => void
}

export type DiagnosticTestOptions = {
  timeoutMs?: number
  /** 超时后为仍存活的已注册进程采集 Windows 转储。 */
  dumpProcessesOnTimeout?: boolean
  retry?: number
  repeats?: number
}

export type DiagnosticTestFileOptions = {
  /** 本测试文件的默认业务超时。 */
  timeoutMs: number
}

type DiagnosticTestBody = (context: DiagnosticTestContext) => unknown | Promise<unknown>
type DiagnosticTest = (name: string, body: DiagnosticTestBody, options?: DiagnosticTestOptions) => void

type DiagnosticState = {
  processes: Map<string, TrackedProcess>
  paths: Map<string, TrackedPath>
}

const diagnosticDirectory = process.env.AIZEN_TEST_DIAGNOSTICS_DIR ?? join(tmpdir(), "aizen-test-diagnostics")
const captureDumpScript = join(import.meta.dir, "../../scripts/ci/capture-process-dump.ps1")

function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

async function inspectPath(target: TrackedPath): Promise<Record<string, unknown>> {
  try {
    const stat = await lstat(target.path)
    return {
      name: target.name,
      path: target.path,
      exists: true,
      kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    }
  } catch (error) {
    return {
      name: target.name,
      path: target.path,
      exists: false,
      errorCode: errorCode(error) ?? "UNKNOWN",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function captureDump(target: TrackedProcess, testName: string): Promise<void> {
  if (process.platform !== "win32" || target.state().exitCode !== null) return
  const safeName = `${testName}-${target.name}`.replace(/[^0-9A-Za-z_-]+/g, "-").replace(/^-+|-+$/g, "")
  const outputPath = join(diagnosticDirectory, `${safeName || "process"}-${target.pid}.dmp`)
  console.error(`[测试诊断] 开始采集进程转储：name=${target.name} pid=${target.pid} path=${outputPath}`)
  const dump = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      captureDumpScript,
      "-ProcessId",
      String(target.pid),
      "-OutputPath",
      outputPath,
    ],
    { stdout: "inherit", stderr: "inherit" },
  )
  const exitCode = await dump.exited
  if (exitCode !== 0) throw new Error(`进程转储命令失败：exit=${exitCode}`)
  console.error(`[测试诊断] 进程转储完成：name=${target.name} pid=${target.pid}`)
}

async function reportTimeout(testName: string, state: DiagnosticState, dumpProcesses: boolean): Promise<void> {
  const memory = process.memoryUsage()
  const report = {
    testName,
    runtime: {
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      uptimeSeconds: process.uptime(),
      memory,
    },
    processes: [...state.processes.values()].map((target) => ({
      name: target.name,
      pid: target.pid,
      ...target.state(),
    })),
    paths: await Promise.all([...state.paths.values()].map(inspectPath)),
  }
  console.error(`[测试诊断] 业务超时状态：\n${JSON.stringify(report, null, 2)}`)

  if (!dumpProcesses) return
  const dumpTargets = [
    {
      name: "bun-test-runtime",
      pid: process.pid,
      state: () => ({ exitCode: null, signalCode: null, killed: false }),
    },
    ...state.processes.values(),
  ]
  await Promise.all(
    dumpTargets.map((target) =>
      captureDump(target, testName).catch((error) => {
        console.error(`[测试诊断] 进程转储失败：name=${target.name} pid=${target.pid}\n${formatError(error)}`)
      }),
    ),
  )
}

function bunOptions(options: DiagnosticTestOptions): TestOptions {
  return {
    timeout: 0,
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    ...(options.repeats === undefined ? {} : { repeats: options.repeats }),
  }
}

/**
 * 为一个测试文件创建统一业务超时入口；每个测试文件必须在本地声明默认超时。
 */
export function createDiagnosticTest(fileOptions: DiagnosticTestFileOptions): DiagnosticTest {
  return (name, body, options = {}) => {
    const testTimeoutMs = options.timeoutMs ?? fileOptions.timeoutMs
    bunTest(
      name,
      async () => {
        const state: DiagnosticState = { processes: new Map(), paths: new Map() }
        const context: DiagnosticTestContext = {
          trackProcess(processName, child) {
            state.processes.set(processName, {
              name: processName,
              pid: child.pid,
              state: () => ({ exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed }),
            })
            return () => state.processes.delete(processName)
          },
          trackPath(pathName, path) {
            state.paths.set(pathName, { name: pathName, path })
            return () => state.paths.delete(pathName)
          },
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        let timedOut = false
        const operation = Promise.resolve().then(() => body(context))
        void operation.catch((error) => {
          if (timedOut) console.error(`[测试诊断] 超时后测试逻辑又失败：${name}\n${formatError(error)}`)
        })
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            void reportTimeout(name, state, options.dumpProcessesOnTimeout ?? false)
              .then(() => reject(new Error(`测试业务超时：${name}，${testTimeoutMs}ms`)))
              .catch(reject)
          }, testTimeoutMs)
        })

        try {
          await Promise.race([operation, timeout])
        } finally {
          if (timer) clearTimeout(timer)
        }
      },
      bunOptions(options),
    )
  }
}
