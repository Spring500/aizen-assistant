# AizenAssistant 安装脚本（Windows）
#
# 用法：
#   iex ((New-Object System.Net.WebClient).DownloadString('https://raw.githubusercontent.com/Spring500/aizen-assistant/main/install.ps1'))
#   powershell -ExecutionPolicy Bypass -File install.ps1 0.1.0   # 指定历史版本（默认最新）
#   $env:GITHUB_TOKEN='xxx'; powershell -File install.ps1 --version 0.2.0-beta.1   # 预发布版（Draft，需 push 权限 token）
#
# 行为：检测架构 → 下载压缩包 → SHA256 校验 → 解压到 %USERPROFILE%\.aizen\bin →
# 幂等写入用户级 PATH（HKCU\Environment，免管理员）→ 写 install.json。
# 只修改用户级位置，不需要管理员权限。重复执行安全（幂等）。

$ErrorActionPreference = "Stop"

$Repository = "Spring500/aizen-assistant"
# 发布网页、API 与下载基地址；可通过 --latest-url / --api-url / --download-url 覆盖测试或镜像入口。
$ReleaseLatest = "https://github.com/$Repository/releases/latest"
$ReleaseApi = "https://api.github.com/repos/$Repository"
$ReleaseDownload = "https://github.com/$Repository/releases/download"
$CustomApi = $false
# 首版已发布平台（与 release 矩阵保持一致；win/linux arm64 待验证后增补，Intel Mac 暂不支持）。
$SupportedPlatforms = @("windows-x64", "linux-x64", "darwin-arm64")
$ConfigDir = Join-Path $env:USERPROFILE ".aizen"
$InstallDir = Join-Path $ConfigDir "bin"
$VersionsDir = Join-Path $ConfigDir "versions"
$DataDir = Join-Path $ConfigDir "data"

$RequestedVersion = ""
$SkipPath = $false
# GitHub token（环境变量或 --token）：仅预发布测试需要——Draft Release 对匿名请求不可见，
# 资产须经鉴权资产 API 下载；正式安装路径不使用 token，行为不变。
$Token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { "" }

# 解析参数：--version / --install-dir / --latest-url / --api-url / --download-url / --token / --skip-path；兼容位置参数形式传入版本号。
for ($i = 0; $i -lt $args.Count; $i++) {
  switch ($args[$i]) {
    "--version" { $i++; if ($i -ge $args.Count -or $args[$i].StartsWith("--")) { throw "--version 必须提供值" }; $RequestedVersion = $args[$i]; break }
    "--install-dir" { $i++; if ($i -ge $args.Count -or $args[$i].StartsWith("--")) { throw "--install-dir 必须提供值" }; $InstallDir = $args[$i]; $ConfigDir = Split-Path $InstallDir -Parent; $VersionsDir = Join-Path $ConfigDir "versions"; $DataDir = Join-Path $ConfigDir "data"; break }
    "--latest-url" { $i++; if ($i -ge $args.Count -or $args[$i].StartsWith("--")) { throw "--latest-url 必须提供值" }; $ReleaseLatest = $args[$i]; break }
    "--api-url" { $i++; if ($i -ge $args.Count -or $args[$i].StartsWith("--")) { throw "--api-url 必须提供值" }; $ReleaseApi = $args[$i]; $CustomApi = $true; break }
    "--download-url" { $i++; if ($i -ge $args.Count -or $args[$i].StartsWith("--")) { throw "--download-url 必须提供值" }; $ReleaseDownload = $args[$i]; break }
    "--token" { $i++; if ($i -ge $args.Count -or $args[$i].StartsWith("--")) { throw "--token 必须提供值" }; $Token = $args[$i]; break }
    "--skip-path" { $SkipPath = $true; break }
    "-h" { Write-Host "用法：install.ps1 [版本号] [--version <v>] [--install-dir <目录>] [--latest-url <url>] [--api-url <url>] [--download-url <url>] [--token <gh-token>] [--skip-path]"; exit 0 }
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

# 查询最新正式版本号（去掉 v 前缀）。默认跟随 GitHub Releases 网页重定向，避免匿名 REST API 限流；
# 显式 --api-url 时保留 JSON API 兼容路径，供测试和自建镜像使用。
function Get-LatestVersion {
  try {
    if ($CustomApi) {
      $release = Invoke-RestMethod -Uri "$ReleaseApi/releases/latest" -Headers @{ "User-Agent" = "aizen-assistant" }
      $tag = [string]$release.tag_name
    } else {
      $response = Invoke-WebRequest -UseBasicParsing -Method Head -Uri $ReleaseLatest -Headers @{ "User-Agent" = "aizen-assistant" }
      $finalUri = $response.BaseResponse.ResponseUri.AbsoluteUri
      $escapedRepository = [regex]::Escape($Repository)
      if ($finalUri -notmatch "/$escapedRepository/releases/tag/(v[^/?#]+)(?:[/?#]|$)") {
        throw "最新版本地址格式异常：$finalUri"
      }
      $tag = [uri]::UnescapeDataString($Matches[1])
    }
    if (-not $tag.StartsWith("v") -or $tag.Length -lt 2) { throw "最新 release 的 tag 格式异常" }
    return $tag.Substring(1)
  } catch {
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

# token 模式下载单个资产：从鉴权 releases 列表定位资产 id，经资产 API 以 octet-stream 下载
#（Draft 资产没有可匿名访问的 browser_download_url，只能走这条通道）。
function Save-AssetWithToken {
  param($Releases, [string]$Tag, [string]$AssetName, [string]$Dest)
  $release = $Releases | Where-Object { $_.tag_name -eq $Tag } | Select-Object -First 1
  if (-not $release) { throw "找不到发布 $Tag（确认 tag 存在且 token 有仓库读权限）" }
  $asset = $release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
  if (-not $asset) { throw "发布 $Tag 中找不到资产 $AssetName" }
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseApi/releases/assets/$($asset.id)" `
    -Headers @{ "User-Agent" = "aizen-assistant"; "Authorization" = "Bearer $Token"; "Accept" = "application/octet-stream" } `
    -OutFile $Dest
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
    if ($Token) {
      # token 模式：经鉴权 API 下载（可见范围含 Draft，供预发布测试；后续校验/解压/落位与匿名路径完全一致）
      $releases = Invoke-RestMethod -Uri "$ReleaseApi/releases?per_page=100" `
        -Headers @{ "User-Agent" = "aizen-assistant"; "Authorization" = "Bearer $Token"; "Accept" = "application/vnd.github+json" }
      Save-AssetWithToken -Releases $releases -Tag "v$Version" -AssetName $zipName -Dest (Join-Path $tmpDir $zipName)
      Save-AssetWithToken -Releases $releases -Tag "v$Version" -AssetName "SHA256SUMS" -Dest (Join-Path $tmpDir "SHA256SUMS")
    } else {
      Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$zipName" -OutFile (Join-Path $tmpDir $zipName)
      Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHA256SUMS" -OutFile (Join-Path $tmpDir "SHA256SUMS")
    }

    $zipPath = Join-Path $tmpDir $zipName
    $expectedLine = Get-Content (Join-Path $tmpDir "SHA256SUMS") | Where-Object { $_.TrimEnd() -like "*$zipName" } | Select-Object -First 1
    if (-not $expectedLine) { throw "SHA256SUMS 中找不到 $zipName" }
    $expected = ($expectedLine -split "\s+")[0]
    $actual = Get-Sha256Hex -Path $zipPath
    if ($expected.ToLower() -ne $actual) { throw "SHA256 校验失败" }

    Expand-Archive -LiteralPath $zipPath -DestinationPath (Join-Path $tmpDir "extracted") -Force
    $exeSource = Join-Path $tmpDir "extracted\aizen-assistant.exe"
    if (-not (Test-Path $exeSource)) { throw "压缩包内未找到可执行文件" }
    $launcherSource = Join-Path $tmpDir "extracted\launcher.exe"
    if (-not (Test-Path $launcherSource)) { throw "压缩包内未找到 launcher（旧版发布包不含 launcher，请安装更新的版本）" }

    # 旧布局迁移必须在包内容验证完整（exe 与 launcher 都存在）之后才执行：
    # 迁移会移走 bin/ 下的旧可执行文件，若先迁移后验包失败（如安装的目标版本
    # 是不含 launcher 的旧发布包），会留下 "bin/ 无启动入口" 的坏中间态，
    # 且因旧布局检测不再命中而无法重跑自愈。
    if (Test-LegacyLayout -InstallDir $InstallDir -ConfigDir $ConfigDir) {
      Write-Host "检测到旧版单文件布局，正在迁移..."
      Convert-LegacyLayout -ConfigDir $ConfigDir -InstallDir $InstallDir -VersionsDir $VersionsDir -DataDir $DataDir
    }

    # 真实可执行文件放入 versions/v<版本>/，bin/ 下放置 launcher（多版本布局：运行中的实例不被替换）
    $versionDir = Join-Path $VersionsDir "v$Version"
    New-Item -ItemType Directory -Path $versionDir -Force | Out-Null
    Copy-Item -Path $exeSource -Destination (Join-Path $versionDir "aizen-assistant.exe") -Force
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Copy-Item -Path $launcherSource -Destination (Join-Path $InstallDir "aizen-assistant.exe") -Force
    # 数据目录固定于安装根，安装时创建保证就绪
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

    $installedVersion = ""
    $versionFile = Join-Path $tmpDir "extracted\version"
    if (Test-Path $versionFile) { $installedVersion = (Get-Content $versionFile -Raw).Trim() }
    if (-not $installedVersion) { $installedVersion = $Version }
    return $installedVersion
  } finally {
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
  }
}

# 写安装来源记录（channel/version/platform/current）。使用无 BOM 的 UTF-8，避免 JSON 解析失败。
function Write-InstallRecord {
  param([string]$Version, [string]$Platform)

  New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
  $recordPath = Join-Path $ConfigDir "install.json"
  $record = @{ channel = "github"; version = $Version; platform = $Platform; current = "v$Version" } | ConvertTo-Json
  [System.IO.File]::WriteAllText($recordPath, $record, [System.Text.UTF8Encoding]::new($false))
}

# 检测旧单文件布局：bin/ 下是完整 exe 且 install.json 无 current 字段（多版本布局才有 current）。
function Test-LegacyLayout {
  param([string]$InstallDir, [string]$ConfigDir)
  if (-not (Test-Path (Join-Path $InstallDir "aizen-assistant.exe"))) { return $false }
  $recordPath = Join-Path $ConfigDir "install.json"
  if (Test-Path $recordPath) {
    try {
      $record = Get-Content $recordPath -Raw | ConvertFrom-Json
      if ($record.current) { return $false }
    } catch {}
  }
  return $true
}

# 从旧单文件布局迁移到多版本布局：旧 exe → versions/v<旧版本>/，bin/.aizen → data/（bin/ 随后由 Install-Release 放置 launcher）。
function Convert-LegacyLayout {
  param([string]$ConfigDir, [string]$InstallDir, [string]$VersionsDir, [string]$DataDir)
  $oldVersion = "legacy"
  $recordPath = Join-Path $ConfigDir "install.json"
  if (Test-Path $recordPath) {
    try {
      $record = Get-Content $recordPath -Raw | ConvertFrom-Json
      if ($record.version) { $oldVersion = $record.version }
    } catch {}
  }
  $versionDir = Join-Path $VersionsDir "v$oldVersion"
  New-Item -ItemType Directory -Path $versionDir -Force | Out-Null
  Move-Item -Force (Join-Path $InstallDir "aizen-assistant.exe") (Join-Path $versionDir "aizen-assistant.exe")
  $oldData = Join-Path $InstallDir ".aizen"
  if (Test-Path $oldData) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    Get-ChildItem -Force $oldData | ForEach-Object { Move-Item -Force -Path $_.FullName -Destination $DataDir }
    Remove-Item -Recurse -Force $oldData -ErrorAction SilentlyContinue
  }
  Write-Host "旧版布局已迁移：versions/v$oldVersion 与 $DataDir"
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
  # 旧布局迁移在 Install-Release 内部、包内容验证之后执行（见其注释），此处不再前置调用
  $installedVersion = Install-Release -Version $version -Platform $platform
  Write-InstallRecord -Version $installedVersion -Platform $platform
  if (-not $SkipPath) { Add-UserPath }

  Write-Host ""
  Write-Host "安装完成：AizenAssistant v$installedVersion（$platform）"
  Write-Host "安装位置：$InstallDir"
  Write-Host "数据目录：$DataDir（固定于安装根，升级不迁移）"
  Write-Host ""
  Write-Host "请重新打开终端后运行："
  Write-Host "  aizen-assistant"
  Write-Host "更新：aizen-assistant update"
  Write-Host "卸载：aizen-assistant uninstall"
}

Main
