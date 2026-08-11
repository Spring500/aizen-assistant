# AizenAssistant 安装脚本（Windows）
#
# 用法：
#   irm https://raw.githubusercontent.com/Spring500/aizen-assistant/main/install.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File install.ps1 0.1.0   # 指定历史版本（默认最新）
#
# 行为：检测架构 → 下载压缩包 → SHA256 校验 → 解压到 %USERPROFILE%\.aizen\bin →
# 幂等写入用户级 PATH（HKCU\Environment，免管理员）→ 写 install.json。
# 只修改用户级位置，不需要管理员权限。重复执行安全（幂等）。

$ErrorActionPreference = "Stop"

$Repository = "Spring500/aizen-assistant"
$ConfigDir = Join-Path $env:USERPROFILE ".aizen"
$InstallDir = Join-Path $ConfigDir "bin"
$PathEntry = '%USERPROFILE%\.aizen\bin'

$RequestedVersion = $args[0]

# 检测真实处理器架构（兼容 32 位 PowerShell 在 64 位系统上运行的情况）。
function Get-Platform {
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    "AMD64" { return "windows-x64" }
    "ARM64" { return "windows-arm64" }
    default { throw "不支持的架构：$arch" }
  }
}

# 查询最新发布版本号（去掉 v 前缀）。
function Get-LatestVersion {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers @{ "User-Agent" = "aizen-assistant" }
  return $release.tag_name.TrimStart("v")
}

# 下载、校验并解压指定版本，把可执行文件放入安装目录；输出实际安装版本号。
function Install-Release {
  param([string]$Version, [string]$Platform)

  $baseUrl = "https://github.com/$Repository/releases/download/v$Version"
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
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zipPath).Hash.ToLower()
    if ($expected.ToLower() -ne $actual) { throw "SHA256 校验失败" }

    Expand-Archive -LiteralPath $zipPath -DestinationPath (Join-Path $tmpDir "extracted") -Force
    $exeSource = Join-Path $tmpDir "extracted\aizen-assistant.exe"
    if (-not (Test-Path $exeSource)) { throw "压缩包内未找到可执行文件" }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Copy-Item -Path $exeSource -Destination (Join-Path $InstallDir "aizen-assistant.exe") -Force

    $installedVersion = (Get-Content (Join-Path $tmpDir "extracted\version") -Raw).Trim()
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

# 幂等写入用户级 PATH（HKCU\Environment）。
function Add-UserPath {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($null -eq $current) { $current = "" }
  $parts = $current -split ";" | Where-Object { $_ -ne "" }
  if ($parts -contains $PathEntry -or $parts -contains $InstallDir) {
    Write-Host "PATH 已配置"
    return
  }
  $newPath = ($parts + $PathEntry) -join ";"
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "已写入用户 PATH"
}

function Main {
  $platform = Get-Platform
  $version = if ($RequestedVersion) { $RequestedVersion.TrimStart("v") } else { Get-LatestVersion }

  Write-Host "安装 AizenAssistant v$version（$platform）"
  $installedVersion = Install-Release -Version $version -Platform $platform
  Write-InstallRecord -Version $installedVersion -Platform $platform
  Add-UserPath

  Write-Host ""
  Write-Host "安装完成：AizenAssistant v$installedVersion（$platform）"
  Write-Host "安装位置：$InstallDir"
  Write-Host "数据目录：$InstallDir\data（随程序目录保存）"
  Write-Host ""
  Write-Host "请重新打开终端后运行："
  Write-Host "  aizen-assistant"
  Write-Host "更新：aizen-assistant update"
  Write-Host "卸载：aizen-assistant uninstall"
}

Main
