<#
.SYNOPSIS
  One-time setup: registers a Windows Task Scheduler task that runs every day at 1:55 AM
  and makes sure Chrome is open (so the MGE extension's 2:00 AM scrape can run).

.USAGE (normal PowerShell window, NOT "Run as administrator" - the task must run as YOU):
  powershell -ExecutionPolicy Bypass -File .\Register-MGEChromeTask.ps1
  # optional: -Time 01:55  -ProfileDirectory "Profile 1"  -Unregister
#>
[CmdletBinding()]
param(
  [string]$Time = '01:55',
  [string]$ProfileDirectory = 'Default',
  [string]$TaskName = 'MGE - Ensure Chrome Running',
  [switch]$Unregister
)
$ErrorActionPreference = 'Stop'

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  return
}

# Copy the helper to a stable per-user location so the task keeps working if this folder moves.
$installDir = Join-Path $env:LOCALAPPDATA 'MGE'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$helperSrc = Join-Path $PSScriptRoot 'Ensure-ChromeRunning.ps1'
$helper = Join-Path $installDir 'Ensure-ChromeRunning.ps1'
Copy-Item -Path $helperSrc -Destination $helper -Force

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$at = [datetime]::ParseExact($Time, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ("-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"{0}`" -ProfileDirectory `"{1}`"" -f $helper, $ProfileDirectory)
$trigger = New-ScheduledTaskTrigger -Daily -At $at
# Interactive = runs in your logged-in desktop session (Chrome must use your normal profile/session).
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description 'Starts Chrome (normal profile) before the MGE nightly NetSuite scrape at 2:00 AM.' -Force | Out-Null

Write-Host "Registered '$TaskName' daily at $Time for $user." -ForegroundColor Green
Write-Host "Helper: $helper   Log: $installDir\ensure-chrome.log"
Write-Host ("Test it now with:  Start-ScheduledTask -TaskName '{0}'" -f $TaskName)

# Wake timers must be allowed for -WakeToRun to wake a sleeping PC (current power plan, AC + battery).
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
$ac = $LASTEXITCODE
powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
$dc = $LASTEXITCODE
powercfg /SETACTIVE SCHEME_CURRENT | Out-Null
if ($ac -eq 0 -and $dc -eq 0) { Write-Host 'Enabled wake timers on the current power plan.' }
else { Write-Warning 'Could not enable wake timers automatically; see docs/SETUP-GUIDE.md (Power settings).' }
