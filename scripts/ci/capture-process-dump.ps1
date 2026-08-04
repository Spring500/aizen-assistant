param(
  [Parameter(Mandatory = $true)]
  [int]$ProcessId,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$procDump = $env:AIZEN_PROCDUMP_PATH
if ([string]::IsNullOrWhiteSpace($procDump) -or -not (Test-Path $procDump)) {
  throw "AIZEN_PROCDUMP_PATH does not point to ProcDump"
}

$directory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $directory -Force | Out-Null
& $procDump -accepteula -mt $ProcessId $OutputPath
if (-not (Test-Path $OutputPath)) {
  throw "ProcDump did not create dump: $OutputPath"
}

$size = (Get-Item $OutputPath).Length
Write-Output "Process dump created: pid=$ProcessId size=$size path=$OutputPath"
