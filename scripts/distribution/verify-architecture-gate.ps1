$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "..\..\dist\aizen-architecture-gate.exe"
if (-not (Test-Path -LiteralPath $source)) {
  throw "架构门禁产物不存在：$source"
}

$sandbox = Join-Path $env:TEMP ("aizen-architecture-gate-" + [guid]::NewGuid())
$oldPath = $env:PATH
try {
  New-Item -ItemType Directory -Path $sandbox | Out-Null
  $executable = Join-Path $sandbox "aizen-architecture-gate.exe"
  Copy-Item -LiteralPath $source -Destination $executable

  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
  if (Get-Command node,bun -CommandType Application -ErrorAction SilentlyContinue) {
    throw "隔离 PATH 中仍可找到 Node 或 Bun"
  }

  $output = & $executable --self-test 2>&1
  $exitCode = $LASTEXITCODE
  $jsonLine = @($output | ForEach-Object { $_.ToString() } | Where-Object { $_.Trim() })[-1]
  $report = $jsonLine | ConvertFrom-Json

  if ($exitCode -ne 0 -or -not $report.passed) {
    $output | ForEach-Object { Write-Error $_ }
    throw "编译产物自检失败，退出码：$exitCode"
  }

  $failed = @($report.checks.PSObject.Properties | Where-Object { -not $_.Value.passed })
  if ($failed.Count -gt 0) {
    throw "存在失败检查：$($failed.Name -join ', ')"
  }

  $files = @(Get-ChildItem -File -LiteralPath $sandbox)
  if ($files.Count -ne 1 -or $files[0].Name -ne "aizen-architecture-gate.exe") {
    throw "产物依赖同目录附加文件"
  }

  Write-Output "单文件无外部运行时验证通过"
} finally {
  $env:PATH = $oldPath
  if (Test-Path -LiteralPath $sandbox) {
    Remove-Item -LiteralPath $sandbox -Recurse -Force
  }
}
