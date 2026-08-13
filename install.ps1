# AizenAssistant 安装脚本（Windows）
#
# 用法：
#   iex ((New-Object System.Net.WebClient).DownloadString('https://raw.githubusercontent.com/Spring500/aizen-assistant/main/install.ps1'))
#   powershell -ExecutionPolicy Bypass -File install.ps1 0.1.0   # 指定历史版本（默认最新）
#
# 行为：检测架构 → 下载压缩包 → SHA256 校验 → 解压到 %USERPROFILE%\.aizen\bin →
# 幂等写入用户级 PATH（HKCU\Environment，免管理员）→ 写 install.json。
# 只修改用户级位置，不需要管理员权限。重复执行安全（幂等）。

$ErrorActionPreference = "Stop"

$Repository = "Spring500/aizen-assistant"
# 发布 API 与下载基地址；可通过 --api-url / --download-url 覆盖（自建镜像或测试场景）。
$ReleaseApi = "https://api.github.com/repos/$Repository"
$ReleaseDownload = "https://github.com/$Repository/releases/download"
# 首版已发布平台（与 release 矩阵保持一致；win/linux arm64 待验证后增补，Intel Mac 暂不支持）。
$SupportedPlatforms = @("windows-x64", "linux-x64", "darwin-arm64")
$ConfigDir = Join-Path $env:USERPROFILE ".aizen"
$InstallDir = Join-Path $ConfigDir "bin"

$RequestedVersion = ""
$SkipPath = $false

# 解析参数：--version / --install-dir / --api-url / --download-url / --skip-path；兼容位置参数形式传入版本号。
for ($i = 0; $i -lt $args.Count; $i++) {
  switch ($args[$i]) {
    "--version" { $i++; if ($i -ge $args.Count -or $args[$i].StartsWith("--")) { throw "--version 必须提供值" }; $RequestedVersion = $args[$i]; break }
    "--install-dir" { $i++; if ($i -ge $args.Count -or $args[$i].StartsWith("--")) { throw "--install-dir 必须提供值" }; $InstallDir = $args[$i]; $ConfigDir = Split-Path $InstallDir -Parent; break }
    "--api-url" { $i++; if ($i -ge $args.Count -or $args[$i].StartsWith("--")) { throw "--api-url 必须提供值" }; $ReleaseApi = $args[$i]; break }
    "--download-url" { $i++; if ($i -ge $args.Count -or $args[$i].StartsWith("--")) { throw "--download-url 必须提供值" }; $ReleaseDownload = $args[$i]; break }
    "--skip-path" { $SkipPath = $true; break }
    "-h" { Write-Host "用法：install.ps1 [版本号] [--version <v>] [--install-dir <目录>] [--api-url <url>] [--download-url <url>] [--skip-path]"; exit 0 }
    default { if ($RequestedVersion -eq "") { $RequestedVersion = $args[$i] } else { throw "未知参数：$($args[$i])" } }
  }
}

# 检测真实处理器架构（兼容 32 位 PowerShell 在 64 位系统上运行的情况）。
function Get-Platform {
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    "AMD64" { return "windows-x64" }
    "ARM64" { return "windows-arm64" }
    default { throw "不支持的架构：$arch" }
  }
}

# 查询最新发布版本号（去掉 v 前缀）；404 表示仓库尚无发布，其它失败保留原始异常信息便于诊断。
function Get-LatestVersion {
  try {
    $release = Invoke-RestMethod -Uri "$ReleaseApi/releases/latest" -Headers @{ "User-Agent" = "aizen-assistant" }
    return $release.tag_name.TrimStart("v")
  } catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -eq 404) {
      throw "仓库尚无正式发布（releases/latest 返回 404），请稍后重试或指定历史版本"
    }
    throw "无法获取最新版本：$($_.Exception.Message)"
  }
}

# 计算文件 SHA256（hex 小写）。用 .NET 直接实现，不依赖 PowerShell 模块自动加载（部分环境不可用）。
function Get-Sha256Hex {
  param([string]$Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $hash = $sha.ComputeHash($stream)
    return ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLower()
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

# 下载、校验并解压指定版本，把可执行文件放入安装目录；输出实际安装版本号。
function Install-Release {
  param([string]$Version, [string]$Platform)

  $baseUrl = "$ReleaseDownload/v$Version"
  $zipName = "aizen-assistant-$Version-$Platform.zip"
  $tmpDir = Join-Path $env:TEMP ("aizen-install-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

  try {
    Write-Host "下载 $zipName ..."
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$zipName" -OutFile (Join-Path $tmpDir $zipName)
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHA256SUMS" -OutFile (Join-Path $tmpDir "SHA256SUMS")

    $zipPath = Join-Path $tmpDir $zipName
    $expectedLine = Get-Content (Join-Path $tmpDir "SHA256SUMS") | Where-Object { $_.TrimEnd() -like "*$zipName" } | Select-Object -First 1
    if (-not $expectedLine) { throw "SHA256SUMS 中找不到 $zipName" }
    $expected = ($expectedLine -split "\s+")[0]
    $actual = Get-Sha256Hex -Path $zipPath
    if ($expected.ToLower() -ne $actual) { throw "SHA256 校验失败" }

    Expand-Archive -LiteralPath $zipPath -DestinationPath (Join-Path $tmpDir "extracted") -Force
    $exeSource = Join-Path $tmpDir "extracted\aizen-assistant.exe"
    if (-not (Test-Path $exeSource)) { throw "压缩包内未找到可执行文件" }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Copy-Item -Path $exeSource -Destination (Join-Path $InstallDir "aizen-assistant.exe") -Force

    $installedVersion = ""
    $versionFile = Join-Path $tmpDir "extracted\version"
    if (Test-Path $versionFile) { $installedVersion = (Get-Content $versionFile -Raw).Trim() }
    if (-not $installedVersion) { $installedVersion = $Version }
    return $installedVersion
  } finally {
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
  }
}

# 写安装来源记录（channel/version/platform）。使用无 BOM 的 UTF-8，避免 JSON 解析失败。
function Write-InstallRecord {
  param([string]$Version, [string]$Platform)

  New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
  $recordPath = Join-Path $ConfigDir "install.json"
  $record = @{ channel = "github"; version = $Version; platform = $Platform } | ConvertTo-Json
  [System.IO.File]::WriteAllText($recordPath, $record, [System.Text.UTF8Encoding]::new($false))
}

# 幂等写入用户级 PATH（HKCU\Environment）。始终写展开后的绝对路径：
# SetEnvironmentVariable 写入的是 REG_SZ，系统不会展开其中的 %VAR%，写 %USERPROFILE% 字面会导致命令查找失败。
function Add-UserPath {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($null -eq $current) { $current = "" }
  $parts = $current -split ";" | Where-Object { $_ -ne "" }
  if ($parts -contains $InstallDir) {
    Write-Host "PATH 已配置"
    return
  }
  $newPath = ($parts + $InstallDir) -join ";"
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "已写入用户 PATH"
}

function Main {
  $platform = Get-Platform
  if ($SupportedPlatforms -notcontains $platform) {
    throw "当前平台（$platform）暂未提供官方安装包（支持：$($SupportedPlatforms -join '、')）"
  }
  $version = if ($RequestedVersion) { $RequestedVersion.TrimStart("v") } else { Get-LatestVersion }

  Write-Host "安装 AizenAssistant v$version（$platform）"
  $installedVersion = Install-Release -Version $version -Platform $platform
  Write-InstallRecord -Version $installedVersion -Platform $platform
  if (-not $SkipPath) { Add-UserPath }

  Write-Host ""
  Write-Host "安装完成：AizenAssistant v$installedVersion（$platform）"
  Write-Host "安装位置：$InstallDir"
  Write-Host "数据目录：$InstallDir\.aizen（随程序目录保存）"
  Write-Host ""
  Write-Host "请重新打开终端后运行："
  Write-Host "  aizen-assistant"
  Write-Host "更新：aizen-assistant update"
  Write-Host "卸载：aizen-assistant uninstall"
}

Main
