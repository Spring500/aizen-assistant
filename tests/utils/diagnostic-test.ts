/**
 * 测试统一超时入口与超时诊断工具。
 *
 * 本文件为全仓库测试提供唯一的超时声明方式：各测试文件通过
 * `createDiagnosticTest({ timeoutMs })` 拿到一个"替身版" test 函数，
 * 用它替代从 bun:test 导入的 test。
 *
 * 它解决两个问题：
 * 1. bun 原生 timeout 不能设 0——bun 会把 0 当作"deadline 已过期"，其 auto_killer
 *    会杀掉该测试 spawn 的子进程。因此这里由"业务超时"先触发并输出诊断现场，
 *    bun 层超时只作为兜底（设为业务超时两倍，下限 30s）。
 * 2. 测试超时若只有一句 "timed out"，事后无法定位原因。因此超时时这里会收集
 *    进程内存、用例通过 trackProcess/trackPath 注册的对象状态，再拒绝并报错。
 *
 * 影响范围：tests/ 与 scripts/dev/ 下几乎所有 .test.ts 都通过本文件声明 test。
 * tests/utils/diagnostic-test.test.ts 会强制所有测试文件走本入口（不得直接从
 * bun:test 导入 test、不得调用 setDefaultTimeout、不得写旧式 `}, 数字)` 超时）。
 */
import { lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test as bunTest, type TestOptions } from "bun:test"

/** 被跟踪的子进程：超时时需要输出其名字、pid 与当前状态。 */
type TrackedProcess = {
  name: string
  pid: number
  state: () => {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    killed: boolean
  }
}

/** 被跟踪的文件系统路径：超时时需要输出其名字与实际路径。 */
type TrackedPath = {
  name: string
  path: string
}

export type DiagnosticTestContext = {
  /** 注册超时时需要检查的子进程，并返回取消注册函数。 */
  trackProcess(name: string, process: Pick<Bun.Subprocess, "pid" | "exitCode" | "signalCode" | "killed">): () => void
  /** 注册超时时需要检查的文件系统路径，并返回取消注册函数。 */
  trackPath(name: string, path: string): () => void
  /** 记录一个检查点：超时报告中会输出其距用例开始、距上一检查点的时间，用于定位慢环节。 */
  checkpoint(name: string): void
}

export type DiagnosticTestOptions = {
  /** 覆盖文件级默认超时的单用例业务超时（毫秒）。 */
  timeoutMs?: number
  /** 超时后为仍存活的已注册进程采集 Windows 转储。 */
  dumpProcessesOnTimeout?: boolean
  /** 透传给 bun 的失败重试次数。 */
  retry?: number
  /** 透传给 bun 的重复执行次数。 */
  repeats?: number
}

export type DiagnosticTestFileOptions = {
  /** 本测试文件的默认业务超时。 */
  timeoutMs: number
}

/** 用例体：接收诊断上下文，返回同步或异步结果。 */
type DiagnosticTestBody = (context: DiagnosticTestContext) => unknown | Promise<unknown>
/** 替身版 test 函数：签名与 bun:test 的 test 一致，额外支持本文件定义的诊断选项。 */
type DiagnosticTest = (name: string, body: DiagnosticTestBody, options?: DiagnosticTestOptions) => void

/** 单个用例运行时收集的诊断状态：已注册的子进程、文件路径与检查点时间线。 */
type DiagnosticState = {
  processes: Map<string, TrackedProcess>
  paths: Map<string, TrackedPath>
  /** 用例体开始执行的单调时间戳（ms），用于计算检查点相对时间。 */
  startedAtMs: number
  /** 上一个检查点的单调时间戳（ms），用于计算检查点间隔。 */
  lastCheckpointAtMs: number
  /** 已记录的检查点：名称、距开始时间、距上一检查点时间。 */
  checkpoints: Array<{ name: string; sinceStartMs: number; sincePrevMs: number }>
}

/** 进程转储与诊断产物输出目录，可用 AIZEN_TEST_DIAGNOSTICS_DIR 覆盖。 */
const diagnosticDirectory = process.env.AIZEN_TEST_DIAGNOSTICS_DIR ?? join(tmpdir(), "aizen-test-diagnostics")
/** 采集 Windows 进程转储的 PowerShell 脚本路径。 */
const captureDumpScript = join(import.meta.dir, "../../scripts/ci/capture-process-dump.ps1")

/** 将任意异常格式化为可读字符串：Error 取 stack，其余取 String 值。 */
function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

/** 从异常对象中安全提取 code 字段（如 ENOENT）；非对象或无 code 时返回 undefined。 */
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

/** 检查被跟踪路径的当前状态：存在性、类型、大小与修改时间；不存在时附带错误码与信息。 */
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

/** 对仍存活的 Windows 进程调用 procdump 采集转储，产物写入诊断目录；非 Windows 或已退出时跳过。 */
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

/**
 * 输出业务超时诊断报告：汇总进程内存、已注册子进程状态、已注册文件路径状态
 * 与检查点时间线，可选地对存活进程采集 Windows 转储。报告写入 stderr，与正常
 * 测试输出区分。检查点末尾会追加一个 "<timeout>" 伪检查点标记超时发生时刻。
 */
async function reportTimeout(testName: string, state: DiagnosticState, dumpProcesses: boolean): Promise<void> {
  const memory = process.memoryUsage()
  const now = performance.now()
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
    checkpoints: [
      ...state.checkpoints,
      {
        name: "<timeout>",
        sinceStartMs: Math.round(now - state.startedAtMs),
        sincePrevMs: Math.round(now - state.lastCheckpointAtMs),
      },
    ],
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

/** 根据业务超时推导传给 bun 的兜底超时，并透传 retry/repeats。 */
function bunOptions(options: DiagnosticTestOptions, businessTimeoutMs: number): TestOptions {
  return {
    // 不能设 timeout: 0——bun 会把 0 当作"deadline 已过期"，其 auto_killer 会杀掉
    // 该测试 spawn 的子进程（打印 "killed N dangling process"）。设成业务超时的两倍
    // （下限 30s），让业务超时（带诊断报告）先触发，同时避免 auto_killer 误伤。
    timeout: Math.max(businessTimeoutMs * 2, 30_000),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    ...(options.repeats === undefined ? {} : { repeats: options.repeats }),
  }
}

/**
 * 为一个测试文件创建统一业务超时入口；每个测试文件必须在本地声明默认超时。
 *
 * 返回的 test(name, body, options) 行为：
 * - body 通过 context 可调用 trackProcess / trackPath 注册"超时时想观察的对象"；
 * - 用 Promise.race 在业务超时（options.timeoutMs ?? 文件默认）到期时输出诊断报告
 *   并让用例失败；
 * - bun 层超时设为业务超时两倍（下限 30s）作为兜底，避免 bun auto_killer 误杀子进程。
 */
export function createDiagnosticTest(fileOptions: DiagnosticTestFileOptions): DiagnosticTest {
  return (name, body, options = {}) => {
    const testTimeoutMs = options.timeoutMs ?? fileOptions.timeoutMs
    bunTest(
      name,
      async () => {
        const startedAtMs = performance.now()
        const state: DiagnosticState = {
          processes: new Map(),
          paths: new Map(),
          startedAtMs,
          lastCheckpointAtMs: startedAtMs,
          checkpoints: [],
        }
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
          checkpoint(checkpointName) {
            const now = performance.now()
            state.checkpoints.push({
              name: checkpointName,
              sinceStartMs: Math.round(now - state.startedAtMs),
              sincePrevMs: Math.round(now - state.lastCheckpointAtMs),
            })
            state.lastCheckpointAtMs = now
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
      bunOptions(options, testTimeoutMs),
    )
  }
}
