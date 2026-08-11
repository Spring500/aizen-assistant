/**
 * 发布链路端到端自检（Windows）：install.ps1 → update → uninstall 全流程。
 *
 * 用法：bun run scripts/repo/e2e-distribution-test.ts
 *
 * 流程：构建产物 → 打包 v0.1.0 / v0.2.0 → 本地 mock release 服务器 →
 * 隔离 USERPROFILE 后执行 install.ps1（查 latest=v0.1.0）→ 断言安装 →
 * 切到 latest=v0.2.0 后执行 update → 断言升级 → 执行 uninstall --yes → 断言卸载与 PATH 回滚。
 *
 * 注意：Windows 用户级 PATH（注册表）无法隔离，install 会真实写入
 * %USERPROFILE%\.aizen\bin、uninstall 会回滚；脚本结束时无论成败都会幂等清理该条目。
 */

import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { randomUUID } from "node:crypto"

const MOCK_PORT_V1 = 18081
const MOCK_PORT_V2 = 18082

/** 简易断言：失败抛出并终止。 */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`断言失败：${message}`)
}

/** 判断路径是否存在。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 计算文件 SHA256（hex 小写）。 */
async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest("hex")
}

/** 等待 HTTP 端点就绪（轮询直到成功或超时）。 */
async function waitForServer(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // 未就绪，继续重试
    }
    await Bun.sleep(200)
  }
  throw new Error(`等待服务器就绪超时：${url}`)
}

/** 启动 mock release 服务器并等待就绪；返回子进程。 */
async function startMockServer(assetsDir: string, version: string, port: number): Promise<Bun.Subprocess> {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      "scripts/repo/mock-release-server.ts",
      "--assets-dir",
      assetsDir,
      "--version",
      version,
      "--port",
      String(port),
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  await waitForServer(`http://localhost:${port}/releases/latest`)
  return proc
}

/** 运行安装的 exe 子命令；返回退出码。 */
async function runInstalledExe(home: string, command: string[], env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn({
    cmd: [join(home, ".aizen", "bin", "aizen-assistant.exe"), ...command],
    env: { ...process.env, USERPROFILE: home, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  if (exitCode !== 0) {
    throw new Error(
      `aizen-assistant ${command.join(" ")} 失败 exit=${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
  }
  console.log(stdout.trim())
  return exitCode
}

/** 幂等移除用户 PATH 中的安装目录条目（测试失败时也能清理现场）。 */
async function cleanupUserPath(): Promise<void> {
  const script = [
    "$entry2 = Join-Path $HOME '.aizen\\bin'",
    "$current = [Environment]::GetEnvironmentVariable('Path','User')",
    "if ($null -eq $current) { exit 0 }",
    "$parts = $current -split ';' | Where-Object { $_.Trim() -ne '' -and $_.Trim() -ne '%USERPROFILE%\\.aizen\\bin' -and $_.Trim() -ne $entry2 }",
    "$new = $parts -join ';'",
    "[Environment]::SetEnvironmentVariable('Path',$new,'User')",
  ].join("; ")
  await Bun.spawn({ cmd: ["powershell", "-NoProfile", "-Command", script] }).exited
}

async function main(): Promise<void> {
  const workRoot = await mkdtemp(join(tmpdir(), `aizen-e2e-${randomUUID()}`))
  const tempHome = join(workRoot, "home")
  const assetsV1 = join(workRoot, "assets-v0.1.0")
  const assetsV2 = join(workRoot, "assets-v0.2.0")
  const servers: Bun.Subprocess[] = []

  try {
    await mkdir(tempHome, { recursive: true })
    await mkdir(assetsV1, { recursive: true })
    await mkdir(assetsV2, { recursive: true })

    // 1. 构建并打包两个版本
    console.log("[1/6] 构建 Windows 产物并打包 v0.1.0 / v0.2.0")
    await Bun.$`bun run build:tui`
    await Bun.$`bun run scripts/repo/package-release.ts --version 0.1.0 --platform windows-x64`
    await Bun.$`bun run scripts/repo/package-release.ts --version 0.2.0 --platform windows-x64`
    for (const [version, assetsDir] of [
      ["0.1.0", assetsV1],
      ["0.2.0", assetsV2],
    ] as const) {
      const zipPath = join("dist", `aizen-assistant-${version}-windows-x64.zip`)
      const zipName = basename(zipPath)
      await copyFile(zipPath, join(assetsDir, zipName))
      await writeFile(join(assetsDir, "SHA256SUMS"), `${await sha256File(zipPath)}  ${zipName}\n`)
    }

    // 2. 起 mock 服务器（v0.1.0）并执行安装
    console.log("[2/6] 启动 mock release（v0.1.0）并执行 install.ps1")
    servers.push(await startMockServer(assetsV1, "0.1.0", MOCK_PORT_V1))
    const installProc = Bun.spawn({
      cmd: ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "install.ps1"],
      env: {
        ...process.env,
        USERPROFILE: tempHome,
        AIZEN_RELEASE_API: `http://localhost:${MOCK_PORT_V1}`,
        AIZEN_RELEASE_DOWNLOAD: `http://localhost:${MOCK_PORT_V1}/download`,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const installExit = await installProc.exited
    const installOut = await new Response(installProc.stdout).text()
    const installErr = await new Response(installProc.stderr).text()
    if (installExit !== 0) throw new Error(`install.ps1 失败 exit=${installExit}\n${installOut}\n${installErr}`)
    console.log(installOut.trim())

    // 3. 断言安装结果
    console.log("[3/6] 断言安装结果")
    assert(await pathExists(join(tempHome, ".aizen", "bin", "aizen-assistant.exe")), "可执行文件未安装")
    const installRecord = JSON.parse(await readFile(join(tempHome, ".aizen", "install.json"), "utf8"))
    assert(installRecord.channel === "github", `install.json.channel 异常：${installRecord.channel}`)
    assert(installRecord.version === "0.1.0", `install.json.version 异常：${installRecord.version}`)
    assert(installRecord.platform === "windows-x64", `install.json.platform 异常：${installRecord.platform}`)
    console.log("安装断言通过：exe 与 install.json 落位正确")

    // 4. 切到 v0.2.0 并执行更新
    console.log("[4/6] 切换 mock release（v0.2.0）并执行 update")
    servers[0]?.kill()
    servers.pop()
    servers.push(await startMockServer(assetsV2, "0.2.0", MOCK_PORT_V2))
    const updateWorkDirsBefore = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("aizen-update-")))
    await runInstalledExe(tempHome, ["update"], { AIZEN_RELEASE_API: `http://localhost:${MOCK_PORT_V2}` })
    await Bun.sleep(3_000) // Windows 延迟替换约 1 秒，留足余量

    // 5. 断言更新结果
    console.log("[5/6] 断言更新结果")
    const updatedRecord = JSON.parse(await readFile(join(tempHome, ".aizen", "install.json"), "utf8"))
    assert(updatedRecord.version === "0.2.0", `更新后 install.json.version 异常：${updatedRecord.version}`)
    // 延迟替换脚本执行到清理步骤即证明替换成功：workDir 含新 exe，未被主流程提前删除，脚本先 Move 再删目录。
    const updateWorkDirsAfter = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("aizen-update-")))
    const leftover = [...updateWorkDirsAfter].filter((name) => !updateWorkDirsBefore.has(name))
    assert(leftover.length === 0, `延迟替换的临时目录未被清理：${leftover.join(",")}`)
    console.log("更新断言通过：版本已升级到 0.2.0，延迟替换已执行")

    // 6. 执行卸载并断言清理
    console.log("[6/6] 执行 uninstall --yes 并断言清理")
    await runInstalledExe(tempHome, ["uninstall", "--yes"], {})
    await Bun.sleep(3_000) // Windows 延迟删除约 1 秒
    if (await pathExists(join(tempHome, ".aizen"))) {
      const leftover =
        await Bun.$`powershell -NoProfile -Command "Get-ChildItem -Recurse -Force '${join(tempHome, ".aizen")}' | Select-Object -ExpandProperty FullName"`
      console.log(`残留内容：\n${leftover.stdout.toString()}`)
    }
    assert(!(await pathExists(join(tempHome, ".aizen"))), "卸载后 ~/.aizen 仍存在")
    const pathProbe = await Bun.$`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','User')"`
    const userPath = pathProbe.stdout.toString() ?? ""
    assert(!userPath.includes(".aizen"), "用户 PATH 中仍残留安装目录条目")
    console.log("卸载断言通过：~/.aizen 已删除，PATH 已回滚")

    console.log("\n端到端测试全部通过")
  } finally {
    for (const server of servers) server.kill()
    await cleanupUserPath()
    await rm(workRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
