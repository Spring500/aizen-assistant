param(
  [Parameter(Mandatory = $true)]
  [int]$ProcessId,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$procDump = $env:AIZEN_PROCDUMP_PATH
if ([string]::IsNullOrWhiteSpace($procDump) -or -not (Test-Path $procDump)) {
  throw "AIZEN_PROCDUMP_PATH 未指向可用的 ProcDump"
}

$directory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $directory -Force | Out-Null
& $procDump -accepteula -mt $ProcessId $OutputPath
if (-not (Test-Path $OutputPath)) {
  throw "ProcDump 未生成转储：$OutputPath"
}

$size = (Get-Item $OutputPath).Length
Write-Output "进程转储已生成：pid=$ProcessId size=$size path=$OutputPath"
