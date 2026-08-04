$ErrorActionPreference = "Stop"

$url = "https://download.sysinternals.com/files/Procdump.zip"
$expectedSha256 = "68E057587B0FD654EFA095F76D80D633C0E5C60EA26FD3E7C0011C076BB2D00C"
$root = Join-Path $env:RUNNER_TEMP "aizen-test-tools"
$archive = Join-Path $root "Procdump.zip"
$destination = Join-Path $root "Procdump"

New-Item -ItemType Directory -Path $root -Force | Out-Null
Invoke-WebRequest -Uri $url -OutFile $archive
$actualSha256 = (Get-FileHash -Path $archive -Algorithm SHA256).Hash
if ($actualSha256 -ne $expectedSha256) {
  throw "ProcDump 归档校验失败：$actualSha256"
}

Expand-Archive -Path $archive -DestinationPath $destination -Force
$procDump = Join-Path $destination "procdump64.exe"
if (-not (Test-Path $procDump)) {
  throw "ProcDump 可执行文件不存在：$procDump"
}

"AIZEN_PROCDUMP_PATH=$procDump" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Output "测试转储工具准备完成：$procDump"
