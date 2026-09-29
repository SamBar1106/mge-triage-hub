<#
.SYNOPSIS
  Starts Google Chrome with the normal (default) profile if it is not already running.
  Run by the "MGE - Ensure Chrome Running" scheduled task at 1:55 AM so the extension's
  2:00 AM alarm can fire. It never closes or restarts an existing Chrome.
#>
[CmdletBinding()]
param(
  [string]$ProfileDirectory = 'Default',
  [string]$StartUrl = ''
)
$ErrorActionPreference = 'Stop'
$logDir = Join-Path $env:LOCALAPPDATA 'MGE'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'ensure-chrome.log'
function Write-MgeLog([string]$m) { Add-Content -Path $log -Value ("{0:u}  {1}" -f (Get-Date), $m) }

function Find-Chrome {
  $candidates = @()
  foreach ($hive in 'HKCU:', 'HKLM:') {
    $key = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
    if (Test-Path $key) { $candidates += (Get-ItemProperty -Path $key).'(default)' }
  }
  $candidates += @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

try {
  $running = Get-Process -Name 'chrome' -ErrorAction SilentlyContinue |
    Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId }
  if ($running) { Write-MgeLog "Chrome already running ($($running.Count) processes)."; exit 0 }

  $chrome = Find-Chrome
  if (-not $chrome) { Write-MgeLog 'ERROR: chrome.exe not found.'; exit 1 }

  $chromeArgs = @("--profile-directory=`"$ProfileDirectory`"", '--no-first-run')
  if ($StartUrl) { $chromeArgs += $StartUrl }
  Start-Process -FilePath $chrome -ArgumentList $chromeArgs -WindowStyle Minimized
  Write-MgeLog "Started Chrome: $chrome (profile $ProfileDirectory)."
  exit 0
} catch {
  Write-MgeLog "ERROR: $($_.Exception.Message)"
  exit 1
}
